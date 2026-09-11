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
import memstore

_mem = memstore.TenantList()
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


def add(instruction: str, time: str = "08:00", days="daily", automation_id: str = "") -> dict:
    """定期実行を登録する。

    automation_id を渡すと、エージェントへの指示ではなく BOARD の自動化
    （automations）を時刻で回す。BOARDの自動化は今まで手動実行しかできず、
    「毎朝〜する」と書いてあるのに発火する仕組みが無かった。
    """
    instruction = (instruction or "").strip()
    automation_id = (automation_id or "").strip()
    if not instruction and not automation_id:
        return {"error": "instruction is empty"}
    time = (time or "08:00").strip()
    sched = {
        "id": str(uuid.uuid4()),
        "instruction": instruction or f"自動化を実行（{automation_id[:8]}）",
        "time": time,
        "days": _normalize_days(days),
        "enabled": True,
        "last_run": "",
        "created_at": _now().isoformat(),
    }
    if automation_id:
        sched["automation_id"] = automation_id
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
    # 入れ物ごと置き換えると、保存先ごとに分けている意味が消える。
    # その場で削る。
    for _i in range(len(_mem) - 1, -1, -1):
        s = _mem[_i]
        if not (s.get("id") != schedule_id):
            del _mem[_i]
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


# 最後に見回りをした時刻。常駐ループが生きているかの唯一の手がかり。
# 無料プランのRenderは無操作で寝るので、朝8時の予約が発火しないことがある。
# 「登録しました」と言われて何も来ないのが一番きついので、
# 生きているかどうかを画面から見えるようにする。
_last_tick: dict = {"at": "", "users": 0, "ran": 0}


def last_tick() -> dict:
    """最後に見回りをした時刻。空なら一度も回っていない。"""
    return dict(_last_tick)


def tick_everyone() -> dict:
    """全員ぶんの定期実行を回す。常駐ループはこちらを呼ぶ。

    調べて分かったこと: これまで常駐ループは tick() を直接呼んでいた。
    tick() はリクエスト文脈を持たないので、保存先はサーバー既定のDBになる。
    各自の予約は各自のDBにあるので、持ち主以外の「毎朝LINEに通知して」は
    登録はできても永久に発火しなかった。鍵も同じで、その人のLINEトークンは
    その人のDBにあるため、仮に発火しても送り先が無い。

    ここで人ごとに保存先を差し替えてから回す。そうすると予約も鍵も
    その人のものが使われる。
    """
    out = {"ran": [], "count": 0, "users": 0, "watched": 0}

    def _merge(res: dict) -> None:
        out["ran"].extend(res.get("ran") or [])
        out["count"] += int(res.get("count") or 0)

    def _round(user_id: str = "") -> None:
        """1人ぶんの見回り。予約の実行と、見張りの両方をここで済ませる。

        見張りを別の周回にすると、保存先の差し替えをもう一度やることになる。
        同じ人のところにいる間に両方やるほうが、往復も少なく取り違えもない。
        """
        _merge(tick(user_id))
        try:
            import watch
            if watch.tick(force=False).get("notified"):
                out["watched"] += 1
        except Exception as e:
            # 見張りの失敗で、予約の実行まで止めない
            print(f"[scheduler] watch error: {e}")

    # 1) サーバー既定（持ち主 / 1人運用）
    try:
        _round("")
    except Exception as e:
        print(f"[scheduler] default tick error: {e}")

    # 2) 自分のDBを繋いでいる人それぞれ
    try:
        import tenancy
        users = tenancy.all_connected_users()
    except Exception as e:
        print(f"[scheduler] cannot list users: {e}")
        return out

    for user_id in users:
        try:
            client = tenancy.client_for(user_id)
            if client is None:
                continue
            token = config.bind_request_client(client)
            try:
                _round(user_id)
                out["users"] += 1
            finally:
                config.reset_request_client(token)
        except Exception as e:
            # 1人ぶんの失敗で、他の人の予約まで止めない
            print(f"[scheduler] user {user_id[:8]}… tick error: {e}")

    _last_tick.update({"at": _now().isoformat(), "users": out["users"], "ran": out["count"]})
    return out


def _park_for_approval(schedule: dict, ev: dict, user_id: str = "") -> str:
    """承認待ちを控えて、通知する。画面に出す一言を返す。

    定期実行は人ごとに保存先を差し替えながら回っている。あとで実行する
    ときに同じ所へ戻れるよう、いまの持ち主を一緒に控える。
    """
    try:
        import approvals
        row = approvals.ask(
            ev.get("tool") or "", ev.get("params") or {},
            note=f"定期実行「{schedule.get('instruction', '')}」の途中で確認が要ります",
            source="schedule", user_id=user_id, why=ev.get("why") or "",
            answer_url=_answer_url(),
        )
        return (f"確認待ちにしました（{ev.get('tool')}）。"
                f"通知から実行するか、アプリの承認待ちから答えてください。[{row['id'][:8]}]")
    except Exception as e:
        return f"(承認待ちを作れませんでした: {e})"


def _answer_url() -> str:
    """通知の「実行する」が叩く先。

    サービスワーカーからは**絶対URL**でないと届かない（アプリの置き場と
    サーバーの置き場が違うため）。
    """
    import os
    base = (os.getenv("PUBLIC_API_URL") or os.getenv("BACKEND_URL") or "").rstrip("/")
    return f"{base}/approvals/answer" if base else "/approvals/answer"


def tick(user_id: str = "") -> dict:
    """実行時刻を過ぎた本日未実行のscheduleを実行する。{ran:[{id,instruction,result}]}。

    `user_id` は「いま誰の保存先に居るか」。承認待ちを控えるときに要る
    ——あとで実行するとき、同じ所へ戻る必要があるため。
    """
    import agent
    ran = []
    for s in _due(list_schedules(1000)):
        final = ""
        auto_id = (s.get("automation_id") or "").strip()
        try:
            if auto_id:
                # BOARDの自動化を時刻で回す（担当AI・根拠資料・条件も効く）
                import automations
                res = automations.run_flow(auto_id)
                final = res.get("error") or res.get("final_output") or ""
                if not res.get("error"):
                    skipped = res.get("skipped") or 0
                    final = (f"[{res.get('name', '自動化')}] 実行 {res.get('ran', 0)}"
                             + (f" / スキップ {skipped}" if skipped else "") + "\n" + final)
            else:
                waiting = None
                for ev in agent.run_stream(s.get("instruction", ""), approval=False):
                    if ev.get("phase") == "final":
                        final = ev.get("text", "")
                    elif ev.get("phase") == "approval":
                        # ここへ来たら run_stream は止まる。今までは final が
                        # 来ないまま抜けて、中身の無い通知だけが残っていた
                        # ——**待っていること自体が誰にも伝わらなかった**。
                        waiting = ev
                if waiting:
                    final = _park_for_approval(s, waiting, user_id)
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
