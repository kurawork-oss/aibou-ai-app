"""
api/automations.py — ノーコード自動化（Zapier風フロー）のエンジン。

1つの自動化(automation)は「トリガー → 複数ステップ」の連鎖。ステップの出力は
{input} プレースホルダーで次へ受け渡す。ダッシュボードで視覚的に組み立て、手動 or
（cron/Webhook 連携で）自動実行する。

ステップ種別:
  - ai_generate : テキスト生成（{input} 等を置換）
  - fetch       : 外のURLを読む（params.url。門番 netguard を必ず通る）
  - notify      : LINE/Discord/Slack へ通知
  - create_task : Active Tasks にタスクを作成

実行は flow_engine に集約している（AI STUDIO のワークフローと同じ1実装）。
そのため自動化のステップでも、担当AI（人格）・根拠資料（VAULT）・実行条件が使える。

ストレージは Supabase `automations`、未設定ならメモリにフォールバック（crashしない）。
"""

import uuid
from typing import List, Optional

import config
import memstore
import flow_engine

_mem_flows = memstore.TenantList()   # 種別は flow_engine と共通（片方だけ増えてずれないように参照する）
STEP_TYPES = list(flow_engine.STEP_TYPES)


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
        norm = {
            "id": str(uuid.uuid4()),
            "n": i,
            "type": st,
            "name": (s.get("name") or st).strip(),
            "params": s.get("params") or {},
        }
        # AI STUDIO と同じ拡張（担当AI・根拠資料・実行条件）も保存する。
        # 指定が無ければ従来どおりの単純な自動化として動く。
        for k in ("prompt", "url", "ai_id", "notebook_id", "when"):
            v = s.get(k)
            if v:
                norm[k] = v
        norm_steps.append(norm)
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
    # 入れ物ごと置き換えると、保存先ごとに分けている意味が消える。
    # その場で削る。
    for _i in range(len(_mem_flows) - 1, -1, -1):
        f = _mem_flows[_i]
        if not (f.get("id") != flow_id):
            del _mem_flows[_i]
    c = config.get_supabase()
    if c:
        try:
            c.table("automations").delete().eq("id", flow_id).execute()
        except Exception:
            pass
    return {"ok": True}


def _resolve_ai(ai_id: str):
    """ステップに担当AIが指定されていれば AI STUDIO のカスタムAIを引く。"""
    if not ai_id:
        return None
    try:
        import studio
        for a in studio.list_ais():
            if a.get("id") == ai_id:
                return a
    except Exception:
        pass
    return None


def run_flow(flow_id: str, input_text: str = "") -> dict:
    """フローのステップを順に実行する。

    実行そのものは flow_engine（AI STUDIOのワークフローと共通の1実装）に任せる。
    これにより自動化のステップでも担当AI・根拠資料・実行条件が使える。
    """
    flow = get_flow(flow_id)
    if not flow:
        return {"error": "automation not found"}
    steps = flow.get("steps") or []
    if not steps:
        return {"error": "automation has no steps"}

    run = flow_engine.run_steps(steps, input_text, resolve_ai=_resolve_ai)

    flow["status"] = "ran"
    skipped = run.get("skipped") or 0
    flow.setdefault("log", []).append(
        f"実行: {run.get('ran', 0)} ステップ" + (f"（スキップ {skipped}）" if skipped else ""))
    _persist(flow)
    return {
        "automation_id": flow_id,
        "name": flow.get("name"),
        **run,
    }
