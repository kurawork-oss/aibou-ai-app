"""
api/automations.py — ノーコード自動化（Zapier風フロー）のエンジン。

1つの自動化(automation)は「トリガー → 複数ステップ」の連鎖。ステップの出力は
{input} プレースホルダーで次へ受け渡す。ダッシュボードで視覚的に組み立て、手動 or
（cron/Webhook 連携で）自動実行する。

ステップ種別:
  - ai_generate : Gemini でテキスト生成（params.prompt 内の {input} を置換）
  - notify      : LINE/Discord/Slack へ通知（params.message 内の {input} を置換）
  - create_task : Active Tasks にタスクを作成（params.title）

ストレージは Supabase `automations`、未設定ならメモリにフォールバック（crashしない）。
"""

import uuid
from typing import List, Optional

import config
import notify
import tasks as tasks_module

_mem_flows: List[dict] = []

STEP_TYPES = ["ai_generate", "notify", "create_task"]


def _persist(flow: dict) -> None:
    c = config.get_supabase()
    if not c:
        return
    try:
        c.table("automations").upsert(flow).execute()
    except Exception:
        pass


def list_flows(limit: int = 50) -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("automations").select("*")
                    .order("created_at", desc=True).limit(limit).execute().data)
            if rows is not None:
                return rows
        except Exception:
            pass
    return list(reversed(_mem_flows))[:limit]


def get_flow(flow_id: str) -> Optional[dict]:
    for f in _mem_flows:
        if f.get("id") == flow_id:
            return f
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("automations").select("*")
                    .eq("id", flow_id).limit(1).execute().data) or []
            if rows:
                return rows[0]
        except Exception:
            pass
    return None


def create_flow(name: str, trigger: Optional[dict] = None, steps: Optional[list] = None) -> dict:
    name = (name or "").strip()
    if not name:
        return {"error": "name is empty"}
    # ステップを正規化（不正な type は除外）
    norm_steps = []
    for i, s in enumerate(steps or [], start=1):
        if not isinstance(s, dict):
            continue
        st = (s.get("type") or "").strip()
        if st not in STEP_TYPES:
            continue
        norm_steps.append({
            "id": str(uuid.uuid4()),
            "n": i,
            "type": st,
            "name": (s.get("name") or st).strip(),
            "params": s.get("params") or {},
        })
    flow = {
        "id": str(uuid.uuid4()),
        "name": name,
        "enabled": True,
        "trigger": trigger or {"type": "manual"},
        "steps": norm_steps,
        "status": "idle",
        "log": [],
    }
    _mem_flows.append(flow)
    _persist(flow)
    return flow


def delete_flow(flow_id: str) -> dict:
    global _mem_flows
    _mem_flows = [f for f in _mem_flows if f.get("id") != flow_id]
    c = config.get_supabase()
    if c:
        try:
            c.table("automations").delete().eq("id", flow_id).execute()
        except Exception:
            pass
    return {"ok": True}


def _run_step(step: dict, current_input: str) -> dict:
    """1ステップを実行し {output, ok, error?} を返す。絶対に raise しない。"""
    st = step.get("type")
    params = step.get("params") or {}

    if st == "ai_generate":
        model = config.get_gemini_model()
        if model is None:
            return {"ok": False, "error": "GEMINI_API_KEY is not configured", "output": ""}
        prompt = (params.get("prompt") or "{input}").replace("{input}", current_input or "")
        try:
            resp = model.generate_content(prompt)
            return {"ok": True, "output": getattr(resp, "text", "") or ""}
        except Exception as e:
            return {"ok": False, "error": f"ai_generate failed: {e}", "output": ""}

    if st == "notify":
        msg = (params.get("message") or "{input}").replace("{input}", current_input or "")
        res = notify.notify_all(msg)
        return {"ok": bool(res.get("ok")), "output": current_input, "notify": res}

    if st == "create_task":
        title = (params.get("title") or current_input or "Automation task").strip()
        content = (params.get("content") or current_input or "")
        task = tasks_module.create_task(title, content, "pending")
        return {"ok": not (isinstance(task, dict) and task.get("error")),
                "output": current_input, "task": task}

    return {"ok": False, "error": f"unknown step type: {st}", "output": current_input}


def run_flow(flow_id: str, input_text: str = "") -> dict:
    """フローのステップを順に実行する。各ステップの結果と最終出力を返す。"""
    flow = get_flow(flow_id)
    if not flow:
        return {"error": "automation not found"}
    steps = flow.get("steps") or []
    if not steps:
        return {"error": "automation has no steps"}

    results = []
    current = input_text or ""
    for step in steps:
        r = _run_step(step, current)
        results.append({
            "step": step.get("n"),
            "name": step.get("name"),
            "type": step.get("type"),
            "ok": r.get("ok"),
            "output": r.get("output", ""),
            "error": r.get("error"),
        })
        # ai_generate の出力は次ステップへ受け渡す
        if step.get("type") == "ai_generate" and r.get("ok"):
            current = r.get("output", "")
        if not r.get("ok") and step.get("type") == "ai_generate":
            # 生成系が失敗したら以降は中断（通知系は続けない）
            break

    flow["status"] = "ran"
    flow.setdefault("log", []).append(f"実行: {len(results)} ステップ")
    _persist(flow)
    return {
        "automation_id": flow_id,
        "name": flow.get("name"),
        "results": results,
        "final_output": current,
    }
