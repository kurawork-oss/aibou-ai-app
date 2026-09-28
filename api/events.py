"""
api/events.py — 変わったことを、開いている画面へすぐ届ける（仕様§38）。

なぜ Supabase Realtime ではないか
---------------------------------
仕様は Supabase Realtime を使う書き方だが、この作りでは**持ち主にしか効かない**。
利用者ごとのデータはその人自身のSupabaseに入り、ブラウザが持っているのは
持ち主のプロジェクトのURLと anon キーだけ。その人のプロジェクトを直接見張るには、
その人の鍵をブラウザへ配る必要がある（いまは service_role をサーバーに預ける形）。

一方、書き込みは全部このサーバーを通る。だからサーバーは何が変わったかを
知っている。人ごとに1本の流れ（SSE）を持ち、変わったら「何が変わったか」
（種類だけ）を流す。

中身は流さない
--------------
受けた画面が、いつもの読み込みで取り直す。流れに中身を載せると、「誰に何を
見せてよいか」の判定をもう1か所に持つことになり、いつか片方だけ緩む。

1つのプロセスの中だけで配る
----------------------------
Render の無料枠は1台なので足りる。台数を増やすときは、ここを Redis などの
配り役に替える（publish / subscribe を呼ぶ側は変えなくてよい）。
"""

import asyncio
import threading
import time
from typing import Dict, List, Tuple

# 流す種類（画面が取り直す単位）。ここに無い物は流さない。
KINDS = {
    "tasks", "agenda", "board", "automations", "missions", "artifacts",
    "notifications", "memory", "vault", "schedules", "income",
}

# 1人が同時に開いておける流れの数。スマホ・ノート・デスクトップ＋タブ数本。
# 超えたら古い物から切る（閉じ忘れたタブが溜まり続けないように）。
MAX_PER_USER = 8
# 読めていない画面に溜める上限。溢れたら捨てる——次に何か変われば、また取り直す。
QUEUE_MAX = 100

_lock = threading.Lock()
_subs: Dict[str, List[Tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}

# 利用者を特定できない構成（1人運用・ログイン無し）で使う名前。
# その構成では、使っているのは1人なので、全部同じ流れでよい。
ANON = "_"


def _key(user: str) -> str:
    return (user or "").strip() or ANON


def subscribe(user: str) -> asyncio.Queue:
    """その人の流れを1本開く。イベントループの中から呼ぶこと。"""
    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
    with _lock:
        subs = _subs.setdefault(_key(user), [])
        subs.append((loop, q))
        while len(subs) > MAX_PER_USER:
            old_loop, old_q = subs.pop(0)
            _put(old_loop, old_q, None)          # None は「閉じて」の合図
    return q


def unsubscribe(user: str, q: asyncio.Queue) -> None:
    with _lock:
        key = _key(user)
        rest = [(lp, x) for (lp, x) in _subs.get(key, []) if x is not q]
        if rest:
            _subs[key] = rest
        else:
            _subs.pop(key, None)


def _put(loop, q, item) -> None:
    """どのスレッドからでも積めるようにする（道具はワーカースレッドで動く）。"""
    def _do():
        try:
            q.put_nowait(item)
        except asyncio.QueueFull:
            pass
    try:
        loop.call_soon_threadsafe(_do)
    except RuntimeError:
        pass                                     # そのループはもう閉じている


def publish(user: str, kind: str) -> int:
    """その人の開いている画面へ「kind が変わった」を流す。流した本数を返す。"""
    if kind not in KINDS:
        return 0
    with _lock:
        subs = list(_subs.get(_key(user), []))
    ev = {"kind": kind, "at": round(time.time(), 3)}
    for loop, q in subs:
        _put(loop, q, ev)
    return len(subs)


def subscribers(user: str) -> int:
    with _lock:
        return len(_subs.get(_key(user), []))


# ── 何が変わったか ───────────────────────────────────────────────────
# 会話の道具。道具はどの入口から来ても tools.execute_tool を通るので、そこで流す。
TOOL_KINDS = {
    "add_task": "tasks", "complete_task": "tasks",
    "add_agenda": "agenda", "calendar_add": "agenda",
    "board_add_note": "board",
    "create_automation": "automations", "run_automation": "automations",
    "create_mission": "missions", "mission_step": "missions",
    "create_document": "artifacts", "create_spreadsheet": "artifacts",
    "create_slides": "artifacts", "generate_image": "artifacts",
    "create_lp": "artifacts", "create_app": "artifacts",
    "save_note": "vault",
    "remember": "memory",
    "schedule_add": "schedules",
    "enqueue_income": "income", "seo_pages": "income", "newsletter_draft": "income",
    "notify": "notifications",
}

# 画面からの書き込み（POST・PUT・PATCH・DELETE）。道の頭で種類を決める。
# 長い物を先に置く（/image/generate を /image より先に見る、のように）。
PATH_KINDS = [
    ("/tasks", "tasks"),
    ("/agenda", "agenda"),
    ("/board", "board"),
    ("/boards", "board"),
    ("/automations", "automations"),
    ("/autopilot", "missions"),
    ("/artifacts", "artifacts"),
    ("/image/generate", "artifacts"),
    ("/lp/generate", "artifacts"),
    ("/notifications", "notifications"),
    ("/memory", "memory"),
    ("/vault", "vault"),
    ("/schedules", "schedules"),
    ("/income", "income"),
    ("/pseo", "income"),          # 副業の画面の SEOページ
    ("/newsletter", "income"),    # 副業の画面のニュースレター
]


def kind_for_path(path: str) -> str:
    p = path or ""
    for head, kind in PATH_KINDS:
        if p == head or p.startswith(head + "/"):
            return kind
    return ""
