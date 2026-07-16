# tasks.py — Active Tasks management（絶対にcrashしない）
# =====================================================================
# タスクの管理。Supabaseが設定されていればDBに永続化、
# なければインメモリで動作（再起動時にリセット）。
#
# Supabase テーブル tasks:
#   id         text    primary key default gen_random_uuid()
#   title      text    not null
#   status     text    default 'pending'
#   content    text    default ''
#   response   text    default ''
#   created_at timestamptz default now()
#   updated_at timestamptz default now()
# =====================================================================

import uuid
from datetime import datetime, timezone
from typing import Optional

import config

# インメモリストア（Supabase未設定時のフォールバック）
_mem_tasks: list = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return str(uuid.uuid4())


def list_tasks(status: Optional[str] = None, limit: int = 100) -> list:
    """タスク一覧を新しい順で返す。status で絞り込み可。"""
    c = config.get_supabase()
    if c:
        try:
            q = c.table("tasks").select("*").order("created_at", desc=True).limit(limit)
            if status:
                q = q.eq("status", status)
            return (q.execute().data) or []
        except Exception:
            pass

    # インメモリ fallback
    items = _mem_tasks[:] if not status else [t for t in _mem_tasks if t.get("status") == status]
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return items[:limit]


VALID_PRIORITIES = ("high", "mid", "low")


def create_task(title: str, content: str = "", status: str = "pending",
                priority: str = "mid", due: str = "", project: str = "") -> dict:
    """タスクを作成して返す。priority: high|mid|low / due: YYYY-MM-DD / project: 任意のグループ名。"""
    title = (title or "").strip()
    if not title:
        return {"error": "title is empty"}
    if priority not in VALID_PRIORITIES:
        priority = "mid"

    task = {
        "id": _uuid(),
        "title": title,
        "content": content or "",
        "status": status,
        "priority": priority,
        "due": (due or "").strip(),
        "project": (project or "").strip(),
        "response": "",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }

    c = config.get_supabase()
    if c:
        try:
            res = c.table("tasks").insert(task).execute()
            return (res.data or [task])[0]
        except Exception:
            # 旧テーブル（新列なし）へのフォールバック：基本フィールドだけで永続化。
            try:
                legacy = {k: task[k] for k in ("id", "title", "content", "status", "response", "created_at", "updated_at")}
                res = c.table("tasks").insert(legacy).execute()
                return (res.data or [task])[0]
            except Exception:
                pass

    _mem_tasks.insert(0, task)
    return task


def update_task(task_id: str, status: Optional[str] = None, response: Optional[str] = None,
                content: Optional[str] = None, priority: Optional[str] = None,
                due: Optional[str] = None, project: Optional[str] = None) -> dict:
    """タスクを更新する。指定されたフィールドのみ更新。"""
    if not task_id:
        return {"error": "task_id is empty"}

    updates: dict = {"updated_at": _now_iso()}
    if status is not None:
        updates["status"] = status
    if response is not None:
        updates["response"] = response
    if content is not None:
        updates["content"] = content
    if priority is not None and priority in VALID_PRIORITIES:
        updates["priority"] = priority
    if due is not None:
        updates["due"] = due.strip()
    if project is not None:
        updates["project"] = project.strip()

    c = config.get_supabase()
    if c:
        try:
            res = c.table("tasks").update(updates).eq("id", task_id).execute()
            rows = res.data or []
            return rows[0] if rows else {"error": "task not found"}
        except Exception as e:
            # 旧テーブル（priority/due/project 列なし）→ 既存列だけで再試行。
            legacy = {k: v for k, v in updates.items()
                      if k in ("updated_at", "status", "response", "content")}
            try:
                res = c.table("tasks").update(legacy).eq("id", task_id).execute()
                rows = res.data or []
                return rows[0] if rows else {"error": "task not found"}
            except Exception:
                return {"error": f"update failed: {e}"}

    # インメモリ fallback
    for task in _mem_tasks:
        if task.get("id") == task_id:
            task.update(updates)
            return task
    return {"error": "task not found"}


def delete_task(task_id: str) -> dict:
    """タスクを削除する。"""
    if not task_id:
        return {"error": "task_id is empty"}

    c = config.get_supabase()
    if c:
        try:
            c.table("tasks").delete().eq("id", task_id).execute()
            return {"ok": True}
        except Exception as e:
            return {"error": f"delete failed: {e}"}

    # インメモリ fallback
    global _mem_tasks
    before = len(_mem_tasks)
    _mem_tasks = [t for t in _mem_tasks if t.get("id") != task_id]
    return {"ok": len(_mem_tasks) < before}
