"""
api/autopilot.py — オートパイロット（ゴール自動実行エンジン）。

ユーザーが「ゴール」を与えると、Gemini がステップに自動分解し、1ステップずつ実行する。
フロント（または cron / GitHub Actions）が run_step を繰り返し呼ぶことで、ゴール達成まで
自動で進む。完了・失敗時には notify 経由でスマホ（LINE / Discord / Slack）へ通知する。

ストレージは Supabase テーブル `missions`、未設定ならプロセス内メモリにフォールバック
（外部サービスが無くても crash しない）。
"""

import json
import re
import uuid
from typing import List, Optional

import config
import notify

# Supabase 未設定時のフォールバック
_mem_missions: List[dict] = []


def _extract_json_array(text: str):
    """```json フェンス or 最初の [ ... ] を JSON 配列として取り出す。失敗時 None。"""
    m = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
    raw = m.group(1).strip() if m else None
    if raw is None:
        s, e = text.find("["), text.rfind("]")
        raw = text[s:e + 1] if (s != -1 and e != -1 and e > s) else None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _decompose(goal: str) -> List[dict]:
    """ゴールを 3〜6 個のステップに分解する。Gemini 無しなら単一ステップ。"""
    model = config.get_gemini_model()
    if model is None:
        return [{"n": 1, "title": goal, "status": "pending", "result": ""}]
    prompt = (
        "あなたはプロジェクトの実行プランナーです。次のゴールを、実行順に並んだ"
        "3〜6個の具体的なステップへ分解してください。各ステップは短い命令形の日本語タイトルにします。"
        "必ず次の形式のJSON配列だけを ```json ... ``` の中に出力してください：\n"
        '["ステップ1のタイトル", "ステップ2のタイトル", ...]\n\n'
        f"ゴール: {goal}"
    )
    try:
        resp = model.generate_content(prompt)
        arr = _extract_json_array(getattr(resp, "text", "") or "")
    except Exception:
        arr = None
    if not arr or not isinstance(arr, list):
        return [{"n": 1, "title": goal, "status": "pending", "result": ""}]
    steps = []
    for i, t in enumerate(arr[:8], start=1):
        title = t if isinstance(t, str) else str(t)
        steps.append({"n": i, "title": title.strip(), "status": "pending", "result": ""})
    return steps or [{"n": 1, "title": goal, "status": "pending", "result": ""}]


def _persist(mission: dict) -> None:
    """Supabase があれば upsert（best-effort）。"""
    c = config.get_supabase()
    if not c:
        return
    try:
        c.table("missions").upsert(mission).execute()
    except Exception:
        pass


def list_missions(limit: int = 50) -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("missions").select("*")
                    .order("created_at", desc=True).limit(limit).execute().data)
            if rows is not None:
                return rows
        except Exception:
            pass
    return list(reversed(_mem_missions))[:limit]


def get_mission(mission_id: str) -> Optional[dict]:
    for m in _mem_missions:
        if m.get("id") == mission_id:
            return m
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("missions").select("*")
                    .eq("id", mission_id).limit(1).execute().data) or []
            if rows:
                return rows[0]
        except Exception:
            pass
    return None


def create_mission(goal: str, notify_on_done: bool = True) -> dict:
    goal = (goal or "").strip()
    if not goal:
        return {"error": "goal is empty"}
    steps = _decompose(goal)
    mission = {
        "id": str(uuid.uuid4()),
        "goal": goal,
        "status": "active",        # active | completed | failed | paused
        "steps": steps,
        "current": 0,
        "log": [f"ゴールを {len(steps)} ステップに分解しました。"],
        "notify": bool(notify_on_done),
    }
    _mem_missions.append(mission)
    _persist(mission)
    return mission


def run_step(mission_id: str) -> dict:
    """次の未完了ステップを1つ実行する。完了/失敗時は通知する。更新後の mission を返す。"""
    mission = get_mission(mission_id)
    if not mission:
        return {"error": "mission not found"}
    if mission.get("status") not in ("active",):
        return {"mission": mission, "done": True, "message": f"mission is {mission.get('status')}"}

    steps = mission.get("steps") or []
    idx = mission.get("current", 0)
    if idx >= len(steps):
        mission["status"] = "completed"
        _persist(mission)
        return {"mission": mission, "done": True}

    step = steps[idx]
    model = config.get_gemini_model()
    if model is None:
        step["status"] = "failed"
        mission["status"] = "failed"
        mission.setdefault("log", []).append("Gemini 未設定のため実行できません。")
        _persist(mission)
        if mission.get("notify"):
            notify.notify_all(f"❌ ゴール失敗: {mission.get('goal')}\nGemini 未設定")
        return {"error": "GEMINI_API_KEY is not configured", "mission": mission}

    # これまでの成果を文脈として渡し、このステップの成果物を生成
    done_ctx = "\n".join(
        f"- {s['title']}: {(s.get('result') or '')[:300]}"
        for s in steps[:idx] if s.get("result")
    )
    prompt = (
        f"あなたは自律エージェントです。最終ゴール「{mission['goal']}」の達成に向け、"
        f"次のステップを実行し、その成果物を日本語で具体的に出力してください。\n\n"
        f"【これまでの成果】\n{done_ctx or '（なし）'}\n\n"
        f"【今回のステップ】\n{step['title']}\n\n【成果物】\n"
    )
    try:
        resp = model.generate_content(prompt)
        result = getattr(resp, "text", "") or ""
    except Exception as e:
        step["status"] = "failed"
        mission["status"] = "failed"
        mission.setdefault("log", []).append(f"ステップ失敗: {e}")
        _persist(mission)
        if mission.get("notify"):
            notify.notify_all(f"❌ ゴール失敗: {mission.get('goal')}\n{e}")
        return {"error": f"step failed: {e}", "mission": mission}

    step["result"] = result
    step["status"] = "done"
    mission["current"] = idx + 1
    mission.setdefault("log", []).append(f"ステップ{step['n']} 完了: {step['title']}")

    done = mission["current"] >= len(steps)
    if done:
        mission["status"] = "completed"
        if mission.get("notify"):
            notify.notify_all(f"✅ ゴール完了: {mission.get('goal')}")
    _persist(mission)
    return {"mission": mission, "done": done, "step": step}


def delete_mission(mission_id: str) -> dict:
    global _mem_missions
    _mem_missions = [m for m in _mem_missions if m.get("id") != mission_id]
    c = config.get_supabase()
    if c:
        try:
            c.table("missions").delete().eq("id", mission_id).execute()
        except Exception:
            pass
    return {"ok": True}
