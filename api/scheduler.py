# scheduler.py — 定期実行（毎日 or 曜日指定、指定時刻にエージェント指示を自動実行）
# =====================================================================
# 例：「毎朝7時にAIニュースを検索してメールで送る」「毎週月・金の9時に◯◯」。
# schedule を保存し、tick() がその日まだ実行していない“時刻を過ぎた”scheduleを
# 実行する（1日1回）。days: "daily" または "mon,wed,fri" のようなカンマ区切り。
#
# 実行トリガは2系統（どちらでも動く）:
#   1) アプリ内の常駐ループ（lifespanで起動・60秒ごと）— サーバーが起きている間。
#   2) POST /scheduler/tick — 外部cron（cron-job.org / GitHub Actions 等・無料）から。
# 定期実行は無人なので承認モードOFF（作成した時点でユーザーが承認済みとみなす）。
# =====================================================================

import uuid
from datetime import datetime, timezone, timedelta
from typing import List

import config

_mem: List[dict] = []


def _now():
    return datetime.now(timezone(timedelta(hours=9)))  # JST


def _today() -> str:
    return _now().strftime("%Y-%m-%d")


# 曜日キー（datetime.weekday() の 0=月 に対応）
_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _normalize_days(days) -> str:
    """days を保存形式に正規化する。"daily" / "mon,wed" 形式（不正値は daily）。"""
    if isinstance(days, (list, tuple)):
        days = ",".join(str(d) for d in days)
    s = (days or "").strip().lower()
    if not s or s == "daily":
        return "daily"
    picked = [d for d in (p.strip() for p in s.split(",")) if d in _DAY_KEYS]
    return ",".join(dict.fromkeys(picked)) or "daily"  # 重複除去・全滅なら daily


def _runs_today(days: str) -> bool:
    """この schedule が今日実行対象か（daily か、今日の曜日を含むか）。"""
    days = (days or "daily").strip().lower()
    if days == "daily":
        return True
    return _DAY_KEYS[_now().weekday()] in [p.strip() for p in days.split(",")]


def list_schedules(limit: int = 100) -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            res = c.table("schedules").select("*").order("time").limit(limit).execute()
            return res.data or []
        except Exception:
            pass
    return list(_mem[:limit])


def add(instruction: str, time: str = "08:00", days="daily") -> dict:
    instruction = (instruction or "").strip()
    if not instruction:
        return {"error": "instruction is empty"}
    time = (time or "08:00").strip()
    sched = {
        "id": str(uuid.uuid4()),
        "instruction": instruction,
        "time": time,
        "days": _normalize_days(days),
        "enabled": True,
        "last_run": "",
        "created_at": _now().isoformat(),
    }
    c = config.get_supabase()
    if c:
        try:
            res = c.table("schedules").insert(sched).execute()
            return (res.data or [sched])[0]
        except Exception:
            pass
    _mem.insert(0, sched)
    return sched


def delete(schedule_id: str) -> dict:
    global _mem
    _mem = [s for s in _mem if s.get("id") != schedule_id]
    c = config.get_supabase()
    if c:
        try:
            c.table("schedules").delete().eq("id", schedule_id).execute()
        except Exception:
            pass
    return {"ok": True}


def _mark_ran(schedule_id: str) -> None:
    today = _today()
    for s in _mem:
        if s.get("id") == schedule_id:
            s["last_run"] = today
    c = config.get_supabase()
    if c:
        try:
            c.table("schedules").update({"last_run": today}).eq("id", schedule_id).execute()
        except Exception:
            pass


def _due(schedules: List[dict]) -> List[dict]:
    now_hm = _now().strftime("%H:%M")
    today = _today()
    due = []
    for s in schedules:
        if not s.get("enabled", True):
            continue
        if (s.get("last_run") or "") == today:
            continue  # already ran today
        if not _runs_today(s.get("days") or "daily"):
            continue  # 曜日指定で今日は対象外
        if (s.get("time") or "08:00") <= now_hm:
            due.append(s)
    return due


def tick() -> dict:
    """実行時刻を過ぎた本日未実行のscheduleを実行する。{ran:[{id,instruction,result}]}。"""
    import agent
    ran = []
    for s in _due(list_schedules(1000)):
        final = ""
        try:
            for ev in agent.run_stream(s.get("instruction", ""), approval=False):
                if ev.get("phase") == "final":
                    final = ev.get("text", "")
        except Exception as e:
            final = f"(実行エラー: {e})"
        _mark_ran(s.get("id"))
        try:
            import notify
            notify.notify_all(f"⏰ 定期実行「{s.get('instruction', '')}」\n{final}")
        except Exception:
            pass
        ran.append({"id": s.get("id"), "instruction": s.get("instruction"), "result": final})
    return {"ran": ran, "count": len(ran)}
