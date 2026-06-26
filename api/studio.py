# studio.py — AI Studio（カスタムAIとワークフロー管理）絶対にcrashしない
# =====================================================================
# ユーザーが独自のAIペルソナやワークフローを作成・実行できるモジュール。
# Supabaseが設定されていればDBに永続化、なければインメモリで動作。
#
# Supabase テーブル studio_ais:
#   id         text  primary key
#   name       text  not null
#   persona    text  default ''
#   model      text  default 'gemini-2.5-flash'
#   rules      text  default ''
#   created_at timestamptz default now()
#
# Supabase テーブル studio_workflows:
#   id         text  primary key
#   name       text  not null
#   steps      jsonb default '[]'  -- [{prompt, ai_id}]
#   created_at timestamptz default now()
# =====================================================================

import uuid
from datetime import datetime, timezone
from typing import Optional

import config

_mem_ais: list = []
_mem_workflows: list = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return str(uuid.uuid4())


# ── カスタムAI ───────────────────────────────────────────────────────

def list_ais() -> list:
    c = config.get_supabase()
    if c:
        try:
            return (c.table("studio_ais").select("*").order("created_at", desc=True)
                    .limit(200).execute().data) or []
        except Exception:
            pass
    return _mem_ais[:]


def create_ai(name: str, persona: str = "", model: str = "", rules: str = "") -> dict:
    name = (name or "").strip()
    if not name:
        return {"error": "name is empty"}
    ai = {
        "id": _uuid(),
        "name": name,
        "persona": persona or "",
        "model": model or "gemini-2.5-flash",
        "rules": rules or "",
        "created_at": _now_iso(),
    }
    c = config.get_supabase()
    if c:
        try:
            res = c.table("studio_ais").insert(ai).execute()
            return (res.data or [ai])[0]
        except Exception:
            pass
    _mem_ais.insert(0, ai)
    return ai


def delete_ai(ai_id: str) -> dict:
    global _mem_ais
    c = config.get_supabase()
    if c:
        try:
            c.table("studio_ais").delete().eq("id", ai_id).execute()
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}
    _mem_ais = [a for a in _mem_ais if a.get("id") != ai_id]
    return {"ok": True}


# ── ワークフロー ─────────────────────────────────────────────────────

def list_workflows() -> list:
    c = config.get_supabase()
    if c:
        try:
            return (c.table("studio_workflows").select("*").order("created_at", desc=True)
                    .limit(200).execute().data) or []
        except Exception:
            pass
    return _mem_workflows[:]


def create_workflow(name: str, steps: list) -> dict:
    name = (name or "").strip()
    if not name:
        return {"error": "name is empty"}
    wf = {
        "id": _uuid(),
        "name": name,
        "steps": steps or [],
        "created_at": _now_iso(),
    }
    c = config.get_supabase()
    if c:
        try:
            res = c.table("studio_workflows").insert(wf).execute()
            return (res.data or [wf])[0]
        except Exception:
            pass
    _mem_workflows.insert(0, wf)
    return wf


def delete_workflow(wf_id: str) -> dict:
    global _mem_workflows
    c = config.get_supabase()
    if c:
        try:
            c.table("studio_workflows").delete().eq("id", wf_id).execute()
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}
    _mem_workflows = [w for w in _mem_workflows if w.get("id") != wf_id]
    return {"ok": True}


def run_workflow(wf_id: str, input_text: str = "") -> dict:
    """ワークフローの各ステップを順番に実行する。"""
    # ワークフローを取得
    c = config.get_supabase()
    wf = None
    if c:
        try:
            rows = c.table("studio_workflows").select("*").eq("id", wf_id).limit(1).execute().data
            if rows:
                wf = rows[0]
        except Exception:
            pass
    if wf is None:
        for w in _mem_workflows:
            if w.get("id") == wf_id:
                wf = w
                break
    if wf is None:
        return {"error": "workflow not found"}

    model = config.get_gemini_model()
    if model is None:
        return {"error": "GEMINI_API_KEY is not configured"}

    steps = wf.get("steps") or []
    if not steps:
        return {"error": "no steps defined"}

    results = []
    current_input = input_text

    for i, step in enumerate(steps):
        prompt_template = step.get("prompt", "")
        if not prompt_template:
            continue
        # {input} プレースホルダーを前ステップの出力で置換
        prompt = prompt_template.replace("{input}", current_input)
        try:
            resp = model.generate_content(prompt)
            step_output = getattr(resp, "text", "") or ""
        except Exception as e:
            step_output = f"[error: {e}]"

        results.append({
            "step": i + 1,
            "name": step.get("name", f"Step {i + 1}"),
            "output": step_output,
        })
        current_input = step_output  # 次ステップへ渡す

    return {
        "workflow_id": wf_id,
        "workflow_name": wf.get("name", ""),
        "results": results,
        "final_output": current_input,
    }
