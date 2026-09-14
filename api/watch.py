"""
api/watch.py — 見張り（監視して、変わったときだけ報せる）。

これまで「朝のブリーフィング」はあったが、中身は 挨拶＋日付＋承認待ちの
副業ジョブ数＋記憶のハイライト だけで、タスクも予定もメールも入っていなかった。
つまり材料は全部あるのに、どこにも集まっていなかった。

ここが集める場所。源（げん）を並べて、それぞれから「気にすべきもの」だけを
取り出し、前回から増えたぶんを見つける。

大事にしていること
------------------
1. 読めなかった源を黙って落とさない。
   全部の源を try で囲って空リストを返すと、メールが読めていなくても
   「新着はありません」と言えてしまう。それは嘘なので、読めなかったことを
   理由つきで必ず持ち帰る。

2. 「増えた」だけを報せる。
   毎回ぜんぶ並べると、2回目からは同じ文面が届き、人は見なくなる。
   品目ごとに変わらない鍵を持たせ、見たことのある鍵は黙って飛ばす。

3. 「気にすべきもの」だけを品目にする。
   タスクは全部ではなく期限が来たものだけ。予定は今日のぶんだけ。
   自分で足したタスクが即座に通知で返ってくるのは、うるさいだけで役に立たない。

4. 初回は鳴らさない。
   見張りを始めた瞬間は全部が「初めて見る鍵」なので、そのまま報せると
   何十件も一度に飛ぶ。最初の1回は黙って覚えるだけにする。

5. 同じ失敗を毎回鳴らさない。
   メールのパスワードが違えば毎回同じ失敗が出る。1時間ごとに
   「メールが読めません」が届くのは通知ではなく嫌がらせなので、
   理由が変わったときだけ報せる。
"""

from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional

import config
import memstore

TABLE = "watch_state"

# 覚えておく鍵の数（源ごと）。増え続けると保存が重くなるので頭を打つ。
MAX_SEEN = 300
# 1回の報せに載せる品目の数。これを超えたら「ほか N 件」にまとめる。
MAX_REPORT_ITEMS = 12
# 保存しておく品目の数（源ごと）。画面に出すぶんだけあればよい。
MAX_CACHED_ITEMS = 30

# 保存先が無いときの控え
_mem_state = memstore.TenantDict()


def _now():
    return datetime.now(timezone(timedelta(hours=9)))     # JST


def _today() -> str:
    return _now().strftime("%Y-%m-%d")


# ── 状態（どこまで見たか） ───────────────────────────────────────────
def _load(source: str) -> dict:
    """源の状態。無ければ「まだ一度も見ていない」を表す形を返す。"""
    blank = {"source": source, "enabled": True, "seen": [], "items": [],
             "last_error": "", "last_run": "", "started": False, "setup_needed": False}
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table(TABLE).select("*").eq("source", source)
                    .limit(1).execute().data) or []
            if rows:
                row = dict(rows[0])
                # jsonb は文字列で返ってくることがある
                import json
                for col in ("seen", "items"):
                    if isinstance(row.get(col), str):
                        try:
                            row[col] = json.loads(row[col])
                        except Exception:
                            row[col] = []
                    if row.get(col) is None:
                        row.pop(col)
                return {**blank, **row}
        except Exception:
            pass
    return {**blank, **(_mem_state.get(source) or {})}


def _save(state: dict) -> None:
    source = state.get("source") or ""
    if not source:
        return
    row = {
        "source": source,
        "enabled": bool(state.get("enabled", True)),
        "seen": list(state.get("seen") or [])[:MAX_SEEN],
        # 前回見えていた品目そのもの。これが無いと、間隔を空けている間に
        # 画面が「何も無い」に見える（本当は前回の中身がまだ生きている）。
        "items": list(state.get("items") or [])[:MAX_CACHED_ITEMS],
        "last_error": (state.get("last_error") or "")[:300],
        "last_run": state.get("last_run") or "",
        "started": bool(state.get("started")),
        "setup_needed": bool(state.get("setup_needed")),
        "updated_at": _now().isoformat(),
    }
    _mem_state[source] = row
    c = config.get_supabase()
    if c:
        try:
            c.table(TABLE).upsert(row, on_conflict="source").execute()
        except Exception:
            pass


# ── 源（げん）── それぞれ「気にすべきもの」だけを返す ────────────────
def _src_tasks() -> dict:
    """期限が来ている未完了タスク。全タスクではない（自分で足した直後に鳴らない）。"""
    try:
        import tasks as tasks_mod
        rows = tasks_mod.list_tasks(status="pending", limit=200)
    except Exception as e:
        return {"ok": False, "error": f"タスクを読めませんでした（{str(e)[:100]}）"}

    today = _today()
    items = []
    for t in rows or []:
        due = (t.get("due") or "").strip()[:10]
        if not due or due > today:
            continue      # 期限なし / まだ先 は静かにしておく
        overdue = due < today
        items.append({
            "key": f"task:{t.get('id')}:{due}",
            "title": t.get("title") or "(無題)",
            "detail": ("期限切れ" if overdue else "今日が期限")
                      + (f"・{t.get('project')}" if t.get("project") else ""),
            "when": due,
            "urgent": overdue or (t.get("priority") == "high"),
        })
    return {"ok": True, "items": items}


def _src_agenda() -> dict:
    """今日〜明日の予定（アプリ内 ＋ Googleカレンダー）。"""
    items: List[dict] = []
    errors: List[str] = []

    try:
        import agenda
        today = _today()
        tomorrow = (_now() + timedelta(days=1)).strftime("%Y-%m-%d")
        for ev in agenda.list_events(limit=200) or []:
            d = (ev.get("date") or "").strip()[:10]
            if d not in (today, tomorrow):
                continue
            items.append({
                "key": f"ev:app:{ev.get('id')}:{d}",
                "title": ev.get("title") or "(無題)",
                "detail": ("今日" if d == today else "明日")
                          + (f" {ev.get('time')}" if ev.get("time") else ""),
                "when": f"{d} {ev.get('time') or ''}".strip(),
                "urgent": d == today,
            })
    except Exception as e:
        errors.append(f"アプリ内の予定（{str(e)[:80]}）")

    try:
        import gservice
        if gservice.connected():
            res = gservice.list_events(days=2, max_results=20)
            if res.get("ok"):
                for ev in res.get("items") or []:
                    start = (ev.get("start") or "")
                    items.append({
                        "key": f"ev:g:{start}:{ev.get('title')}",
                        "title": ev.get("title") or "(無題)",
                        "detail": f"Googleカレンダー {start[:16].replace('T', ' ')}",
                        "when": start,
                        "urgent": start[:10] == _today(),
                        "url": ev.get("url") or "",
                    })
            else:
                errors.append(f"Googleカレンダー（{res.get('error', '')[:80]}）")
    except Exception as e:
        errors.append(f"Googleカレンダー（{str(e)[:80]}）")

    if errors and not items:
        return {"ok": False, "error": " / ".join(errors)}
    out = {"ok": True, "items": items}
    if errors:
        out["warning"] = " / ".join(errors)
    return out


def _src_work() -> dict:
    """業務。承認を待っているもの・進行中で止まっているもの。"""
    items: List[dict] = []
    try:
        import income
        for j in income.list_jobs(status="pending", limit=50) or []:
            items.append({
                "key": f"job:{j.get('id')}",
                "title": j.get("theme") or "(無題のジョブ)",
                "detail": "承認待ち",
                "when": (j.get("created_at") or "")[:10],
                "urgent": False,
            })
    except Exception:
        pass       # 副業はオーナー限定。使っていない人で鳴らさない

    try:
        import autopilot
        for m in autopilot.list_missions(limit=30) or []:
            if m.get("status") != "active":
                continue
            steps = m.get("steps") or []
            cur = int(m.get("current") or 0)
            if cur >= len(steps):
                continue
            items.append({
                "key": f"mission:{m.get('id')}:{cur}",
                "title": m.get("goal") or "(無題のゴール)",
                "detail": f"進行中 {cur}/{len(steps)}ステップ・次は「{steps[cur].get('title', '')}」",
                "when": "",
                "urgent": False,
            })
    except Exception as e:
        return {"ok": False, "error": f"業務を読めませんでした（{str(e)[:100]}）"}
    return {"ok": True, "items": items}


def _src_mail() -> dict:
    """受信トレイの新着。"""
    try:
        import email_svc
        if not email_svc.configured():
            return {"ok": False, "skipped": True,
                    "error": "メールが未設定です",
                    "hint": "「連携」で EMAIL_ADDRESS と EMAIL_PASSWORD"
                            "（Gmailはアプリパスワード）を入れてください"}
        res = email_svc.inbox(limit=10)
    except Exception as e:
        return {"ok": False, "error": f"メールを読めませんでした（{str(e)[:100]}）"}

    if not res.get("ok"):
        return {"ok": False, "error": f"メールを読めませんでした（{res.get('error', '')[:120]}）"}

    items = []
    for m in res.get("items") or []:
        items.append({
            "key": f"mail:{m.get('id') or (m.get('date', '') + m.get('subject', ''))}",
            "title": m.get("subject") or "(件名なし)",
            "detail": f"{m.get('from', '')}｜{(m.get('snippet') or '')[:60]}",
            "when": m.get("date") or "",
            "urgent": False,
        })
    return {"ok": True, "items": items}


def _src_slack() -> dict:
    """Slackの新しい発言。"""
    try:
        import slackread
        if not slackread.configured():
            return {"ok": False, "skipped": True,
                    "error": "Slackの読み取りが未設定です",
                    "hint": "Slack Appを作って Bot トークン（xoxb-…）を "
                            "SLACK_BOT_TOKEN に入れてください。"
                            "通知用の SLACK_WEBHOOK は送信専用なので読めません"}
        res = slackread.recent(limit=20)
    except Exception as e:
        return {"ok": False, "error": f"Slackを読めませんでした（{str(e)[:100]}）"}

    if not res.get("ok"):
        return {"ok": False, "error": f"Slackを読めませんでした（{res.get('error', '')[:120]}）"}

    items = [{
        "key": f"slack:{m.get('key')}",
        "title": f"#{m.get('channel')} {m.get('who') or ''}".strip(),
        "detail": m.get("text") or "",
        "when": m.get("ts") or "",
        "urgent": False,
    } for m in res.get("items") or []]
    out = {"ok": True, "items": items}
    if res.get("warning"):
        out["warning"] = res["warning"]
    if res.get("note"):
        out["hint"] = res["note"]
    return out


def _src_line() -> dict:
    """LINEで届いたメッセージ（Webhookで受け取ったもの）。"""
    try:
        import inbox
        import keychain
        if not (keychain.get_key("LINE_CHANNEL_SECRET") or "").strip():
            return {"ok": False, "skipped": True,
                    "error": "LINEの受信が未設定です",
                    "hint": "LINE Developers でチャネルシークレットを LINE_CHANNEL_SECRET に入れ、"
                            "Webhook URL を登録してください（下に出ているURLをそのまま貼れます）"}
        rows = inbox.list_messages(channel="line", limit=30)
    except Exception as e:
        return {"ok": False, "error": f"LINEを読めませんでした（{str(e)[:100]}）"}

    items = [{
        "key": f"line:{m.get('external_id') or m.get('id')}",
        "title": "LINE",
        "detail": m.get("text") or "",
        "when": m.get("created_at") or "",
        "urgent": False,
    } for m in rows]
    return {"ok": True, "items": items}


# 源の並び。上から順に報告に出る。
# min_interval は「最短どれくらい空けて見に行くか」（秒）。
# 手元のDBを読むだけのものは短く、外に出るものは長くする。
SOURCES: List[dict] = [
    {"key": "tasks", "label": "タスク", "collect": _src_tasks, "min_interval": 60},
    {"key": "agenda", "label": "予定", "collect": _src_agenda, "min_interval": 300},
    {"key": "work", "label": "業務", "collect": _src_work, "min_interval": 60},
    {"key": "mail", "label": "メール", "collect": _src_mail, "min_interval": 300},
    {"key": "slack", "label": "Slack", "collect": _src_slack, "min_interval": 300},
    {"key": "line", "label": "LINE", "collect": _src_line, "min_interval": 60},
]

_BY_KEY: Dict[str, dict] = {s["key"]: s for s in SOURCES}


def source_keys() -> List[str]:
    return [s["key"] for s in SOURCES]


def set_enabled(source: str, enabled: bool) -> dict:
    if source not in _BY_KEY:
        return {"error": f"知らない監視対象です（{source}）"}
    st = _load(source)
    st["enabled"] = bool(enabled)
    _save(st)
    return {"ok": True, "source": source, "enabled": bool(enabled)}


# ── 集める ───────────────────────────────────────────────────────────
def _due_to_run(st: dict, min_interval: int, force: bool) -> bool:
    """前に見てから十分に時間が経ったか。画面からの「今すぐ」は無条件で通す。"""
    if force:
        return True
    last = (st.get("last_run") or "").strip()
    if not last:
        return True
    try:
        prev = datetime.fromisoformat(last)
    except Exception:
        return True
    return (_now() - prev).total_seconds() >= max(0, int(min_interval or 0))


def collect(force: bool = True, only: Optional[List[str]] = None) -> dict:
    """全部の源を見て、状態と品目を返す。状態は保存しない（読むだけ）。

    force=False のときは、前回から間もない源は見に行かず skipped で返す。
    見張りの定期実行はこちらを使う（毎分IMAPに繋ぎに行かないため）。
    """
    out = {"sources": [], "checked_at": _now().isoformat()}
    for s in SOURCES:
        key = s["key"]
        if only and key not in only:
            continue
        st = _load(key)
        # _state は呼び出し側（tick）が状態を読み直さずに済ませるための持ち回り。
        # 覚えている鍵が300件あるので、外へ返す前に public() で必ず落とす。
        block = {"key": key, "label": s["label"], "enabled": bool(st.get("enabled", True)),
                 "items": [], "new": [], "ok": True, "error": "", "hint": "",
                 "skipped": False, "started": bool(st.get("started")), "_state": st}

        if not block["enabled"]:
            block["skipped"] = True
            block["error"] = "この対象は見張りを止めています"
            out["sources"].append(block)
            continue

        if _due_to_run(st, s.get("min_interval", 60), force):
            try:
                res = s["collect"]() or {}
            except Exception as e:
                # 源の実装が想定外に落ちても、他の源は見る
                res = {"ok": False, "error": f"読み取りが失敗しました（{str(e)[:120]}）"}
            block["fresh"] = True
            block["ok"] = bool(res.get("ok"))
            block["error"] = res.get("error") or ""
            block["hint"] = res.get("hint") or ""
            block["warning"] = res.get("warning") or ""
            block["setup_needed"] = bool(res.get("skipped"))
            items = res.get("items") or []
        else:
            # 前に見たときの中身をそのまま使う。
            # ここで空にすると、画面を開くたびにメールやSlackへ実際に繋ぎに
            # 行かないと何も出せない。開くのが遅かったのは、これが理由だった。
            block["fresh"] = False          # 今回は見に行っていない印
            block["error"] = st.get("last_error") or ""
            block["setup_needed"] = bool(st.get("setup_needed"))
            block["ok"] = not block["error"] and not block["setup_needed"]
            items = list(st.get("items") or [])

        # 新着かどうかは、控えから出したときも同じように見る。
        # ここで一律「新着ではない」にすると、画面を開いて拾えた新着が、
        # そのあとの見回りでも新着として扱われず、通知が出ないまま消える。
        seen = set(st.get("seen") or [])
        block["items"] = [{**dict(it), "is_new": it.get("key") not in seen} for it in items]
        block["new"] = [i for i in block["items"] if i.get("is_new")]
        out["sources"].append(block)
    return out


def public(data: dict) -> dict:
    """外へ返してよい形にする（内部持ち回りの _state を落とす）。"""
    return {**data, "sources": [{k: v for k, v in b.items() if not k.startswith("_")}
                                for b in (data.get("sources") or [])]}


def _remember(block: dict) -> None:
    """見た品目を覚える。次からは新着として数えない。"""
    st = block.get("_state") or _load(block["key"])
    seen = list(st.get("seen") or [])
    items = block.get("items") or []
    fresh_keys = [i["key"] for i in items if i.get("key")]
    # 新しいものを前に置き、古い鍵から捨てる
    merged = fresh_keys + [k for k in seen if k not in set(fresh_keys)]
    st["seen"] = merged[:MAX_SEEN]
    # 中身も控えておく（次に画面を開いたとき、繋ぎ直さずに出せるように）
    st["items"] = [{k: v for k, v in i.items() if k != "is_new"} for i in items][:MAX_CACHED_ITEMS]
    st["last_run"] = _now().isoformat()
    st["started"] = True
    st["last_error"] = block.get("error") or ""
    st["setup_needed"] = bool(block.get("setup_needed"))
    _save(st)


# ── 文にする ─────────────────────────────────────────────────────────
def _lines_for(block: dict, items: List[dict]) -> List[str]:
    lines = [f"【{block['label']}】{len(items)}件"]
    for it in items[:MAX_REPORT_ITEMS]:
        mark = "❗" if it.get("urgent") else "・"
        detail = (it.get("detail") or "").replace("\n", " ")[:80]
        lines.append(f"{mark}{it.get('title', '')}" + (f" — {detail}" if detail else ""))
    if len(items) > MAX_REPORT_ITEMS:
        lines.append(f"…ほか {len(items) - MAX_REPORT_ITEMS} 件")
    return lines


def render(data: dict, new_only: bool = False) -> str:
    """collect() の結果を、読める文にする。

    読めなかった源は必ず本文に出す。ここで省くと「新着はありません」が
    嘘になる（本当は見に行けていないだけ）。
    """
    body: List[str] = []
    troubles: List[str] = []
    setup: List[str] = []

    for b in data.get("sources") or []:
        if b.get("skipped") and not b.get("error"):
            continue
        if b.get("setup_needed"):
            setup.append(f"・{b['label']}：{b.get('error', '')}")
            continue
        if not b.get("ok"):
            troubles.append(f"・{b['label']}：{b.get('error', '')}")
            continue
        if b.get("skipped"):
            continue
        items = b.get("new") if new_only else b.get("items")
        if items:
            body.extend(_lines_for(b, items))
        if b.get("warning"):
            troubles.append(f"・{b['label']}：{b['warning']}")

    out: List[str] = []
    if body:
        out.extend(body)
    elif not new_only:
        out.append("いま気にすべきものはありません。")
    if troubles:
        out.append("")
        out.append("⚠ 見に行けなかったもの（新着が無いのではなく、確認できていません）:")
        out.extend(troubles)
    if setup and not new_only:
        out.append("")
        out.append("未設定（設定すれば見張れます）:")
        out.extend(setup)
    return "\n".join(out).strip()


def _remember_view(data: dict) -> None:
    """画面に出したぶんを控えておく（次に開いたとき繋ぎ直さずに済むように）。

    「見たことにする」（seen）は動かさない。ここで動かすと、画面をちらっと
    開いただけで新着が消え、そのあとの見回りで通知が出なくなる。
    控えるのは中身と、いつ見に行ったかだけ。
    """
    for b in data.get("sources") or []:
        if not b.get("fresh"):
            continue                      # 見に行っていないものを書き直さない
        st = b.get("_state") or _load(b["key"])
        st["items"] = [{k: v for k, v in i.items() if k != "is_new"}
                       for i in (b.get("items") or [])][:MAX_CACHED_ITEMS]
        st["last_run"] = _now().isoformat()
        st["last_error"] = b.get("error") or ""
        st["setup_needed"] = bool(b.get("setup_needed"))
        _save(st)


def report(new_only: bool = False, force: bool = False) -> dict:
    """画面や会話から呼ぶ。文と内訳を返す。

    既定では見に行かない。画面を開くたびにメール（IMAPのログイン）や
    Slack・Googleカレンダーへ実際に繋ぐと、HOMEを開くだけで数秒待たされる。
    間隔を空けているあいだは、前回の中身をそのまま出す。
    「今すぐ確認」を押したときだけ force=True で本当に見に行く。
    """
    data = collect(force=force)
    _remember_view(data)
    return {"ok": True, "text": render(data, new_only=new_only), **public(data)}


# ── 見張り本体（定期実行から呼ばれる） ───────────────────────────────
def tick(force: bool = False) -> dict:
    """変化を探し、あったときだけ通知する。無ければ何もしない。

    戻り値の notified が False でも失敗ではない（変化が無かっただけ）。
    """
    data = collect(force=force)
    new_blocks: List[dict] = []
    trouble_lines: List[str] = []
    total_new = 0

    for b in data.get("sources") or []:
        if b.get("skipped") and not b.get("fresh"):
            continue
        prev_error = ((b.get("_state") or {}).get("last_error") or "")

        if not b.get("ok"):
            # 未設定は「壊れている」ではないので鳴らさない（画面には出る）
            if not b.get("setup_needed") and b.get("error") and b["error"] != prev_error:
                trouble_lines.append(f"・{b['label']}：{b['error']}")
            _remember_error(b)
            continue

        first_time = not b.get("started")
        _remember(b)

        # 直ったことは、初回扱いでも必ず報せる。
        # ずっと失敗していた源には控えが無いので started が立っておらず、
        # 先に初回で抜けてしまうと「直りました」が永久に出なかった。
        if prev_error:
            trouble_lines.append(f"・{b['label']}：読めるようになりました")

        if first_time:
            # 控えが無い状態で読めたときは、中身をまとめて鳴らさない。
            # 溜まっていたぶんが一度に何十件も飛ぶため。
            continue
        if b.get("new"):
            total_new += len(b["new"])
            new_blocks.append(b)

    if not new_blocks and not trouble_lines:
        return {"ok": True, "notified": False, "new": 0}

    lines: List[str] = []
    if new_blocks:
        lines.append(f"👀 新しい動きが {total_new} 件あります")
        for b in new_blocks:
            lines.extend(_lines_for(b, b["new"]))
    if trouble_lines:
        if lines:
            lines.append("")
        lines.append("⚠ 見張りの状態が変わりました:")
        lines.extend(trouble_lines)

    text = "\n".join(lines)
    sent = {}
    try:
        import notify
        sent = notify.notify_all(text)
    except Exception as e:
        sent = {"ok": False, "error": str(e)[:120]}
    return {"ok": True, "notified": True, "new": total_new, "text": text, "sent": sent}


def _remember_error(block: dict) -> None:
    """読めなかったことを覚える。品目は上書きしない（前に見たものを忘れない）。"""
    st = block.get("_state") or _load(block["key"])
    st["last_error"] = block.get("error") or ""
    st["setup_needed"] = bool(block.get("setup_needed"))
    st["last_run"] = _now().isoformat()
    _save(st)


def tick_all_users() -> dict:
    """全員ぶんの見張りを回す。scheduler と同じやり方で保存先を差し替える。"""
    out = {"users": 0, "notified": 0}

    def _one() -> None:
        res = tick(force=False)
        if res.get("notified"):
            out["notified"] += 1

    try:
        _one()
    except Exception as e:
        print(f"[watch] default tick error: {e}")

    try:
        import tenancy
        users = tenancy.all_connected_users()
    except Exception as e:
        print(f"[watch] cannot list users: {e}")
        return out

    for user_id in users:
        try:
            client = tenancy.client_for(user_id)
            if client is None:
                continue
            token = config.bind_request_client(client)
            try:
                _one()
                out["users"] += 1
            finally:
                config.reset_request_client(token)
        except Exception as e:
            print(f"[watch] user {user_id[:8]}… tick error: {e}")
    return out
