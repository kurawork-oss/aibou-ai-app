# memory_sync.py — 端末の記憶とサーバーの記憶を合流させる
# =====================================================================
# なぜ要るのか
# ------------
# 端末の中の長期記憶（webapp/src/lib/memory.ts）は、これまで**島**だった。
#
#   ・端末で覚えたことは、サーバーへ上がらない
#     → 機種変すると、覚えていたことが全部消える
#   ・サーバーが覚えたことは、端末へ降りてこない
#     → 圏外では、サーバー側の記憶を1件も思い出せない
#   ・2台目の端末は、いつまでも空のまま
#
# 「Web とローカルのハイブリッド長期記憶」と言う以上、ここが繋がっていないと
# 名前負けする。両方向に持っていくのがこのモジュール。
#
# 何を運び、何を運ばないか
# ------------------------
# 運ぶのは**選ばれた記憶**だけ（role が 'fact' か 'note'）。
# 会話の生ログ（role='user' / 'assistant'）は運ばない。運ぶと、端末の
# 2000件の枠が数日で会話ログに埋まり、肝心の「覚えておいてほしいこと」が
# 押し出される。生ログはサーバーに置いたままでよい（サーバーは広い）。
#
# ぶつかったときの決め方
# ----------------------
# **updated_at が新しいほうが勝つ**（last writer wins）。単純だが、
# この種類のデータには合っている——同じ記憶を2台で同時に別々に直す、
# という場面がほぼ無いため。凝った解決（3-way merge 等）を入れると、
# 直した覚えのない文章が出てくるほうの事故が増える。
#
# 墓標（deleted_at）も同じ土俵で競う。これが無いと、片方で消した記憶が
# もう片方から**復活する**。「忘れて」と言ったことが戻ってくるのは、
# 覚えないことより体感が悪い。
#
# 古いDBに当たったとき
# --------------------
# updated_at 列が無いDB（schema を流していない人）では、黙って半分だけ
# 動かさない。`ok=False` と理由を返して、画面にそう出す。
# 「同期しました」と言って何も起きていないのが、いちばん困る。
# =====================================================================

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from config import get_supabase

# memory_store と同じ固定値。分離は「どのDBに繋ぐか」で行っているので、
# その人のDBの中ではこの値で一貫していればよい。
DEFAULT_USER_ID = "local"

# 端末と揃える記憶の種類。会話の生ログはここに入れない。
SYNC_ROLES = ("fact", "note")

# 1回のやり取りで運ぶ上限。超えたぶんは次の呼び出しで運ぶ（more=True）。
MAX_PUSH = 500
MAX_PULL = 500

# 端末側（memory.ts）と同じ上限。
MAX_TEXT = 2000

_SYNC_READY = "_aibou_memory_sync_ready"   # updated_at 列があるか（クライアントに覚えさせる）


def _remember(client, attr: str, value) -> None:
    try:
        setattr(client, attr, value)
    except Exception:
        pass


def _ms(value: Any) -> int:
    """timestamptz を ミリ秒に。読めないものは 0（＝いちばん古い扱い）。"""
    if not value:
        return 0
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def _iso(ms: Any) -> Optional[str]:
    """ミリ秒を timestamptz の文字列に。0 や None は None（＝列を空に）。"""
    try:
        n = int(ms or 0)
    except Exception:
        return None
    if n <= 0:
        return None
    return datetime.fromtimestamp(n / 1000, tz=timezone.utc).isoformat()


def now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def schema_ready(client=None) -> bool:
    """このDBが合流に必要な列を持っているか。

    無いDBに対して毎回 select を投げないよう、一度分かったら覚えておく。
    （プロセスを再起動すると「不明」に戻り、また試す——schema を流した人が
      再起動なしでずっと断られ続けないように。）
    """
    c = client or get_supabase()
    if c is None:
        return False
    known = getattr(c, _SYNC_READY, None)
    if known is not None:
        return bool(known)
    try:
        c.table("agent_memory").select("id,updated_at,deleted_at").limit(1).execute()
        _remember(c, _SYNC_READY, True)
        return True
    except Exception:
        _remember(c, _SYNC_READY, False)
        return False


def _clean(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """端末から来た1件を、そのまま書ける形に整える。

    外から来た値なので、長さも種類も信じない。ここを緩めると、端末側の
    不具合や細工した通信が、そのままDBの中身になる。
    """
    if not isinstance(item, dict):
        return None
    ident = str(item.get("id") or "").strip()
    # id は端末が作った UUID。長さだけ見て、変な値は落とす
    if not ident or len(ident) > 64:
        return None

    deleted = _iso(item.get("deletedAt"))
    text = str(item.get("text") or "")[:MAX_TEXT]
    # 墓標は中身が空でよい。生きている記憶で中身が空なら、運ぶ意味が無い
    if not text.strip() and not deleted:
        return None
    # 消された記憶の**中身は残さない**。
    # 墓標は「消したという事実」を運ぶためだけの物で、文章そのものは要らない。
    # 残すと、想起の絞り込みをどこか1か所で書き忘れただけで、消したはずの
    # 文がAIへ渡る。消したい理由はたいてい中身のほうにあるので、
    # 「絞り込みで見せない」ではなく「持たない」にする。
    if deleted:
        text = ""

    role = str(item.get("kind") or "note")
    if role not in SYNC_ROLES:
        role = "note"
    try:
        importance = max(0, min(2, int(item.get("importance") or 0)))
    except Exception:
        importance = 0

    updated = _iso(item.get("updatedAt")) or _iso(now_ms())
    created = _iso(item.get("createdAt")) or updated

    return {
        "id": ident,
        "user_id": DEFAULT_USER_ID,
        "role": role,
        "content": text,
        "importance": importance,
        "created_at": created,
        "updated_at": updated,
        "deleted_at": deleted,
    }


def _to_client(row: Dict[str, Any]) -> Dict[str, Any]:
    """DBの行を、端末の memory.ts が読める形に。"""
    out = {
        "id": str(row.get("id") or ""),
        "text": str(row.get("content") or ""),
        "kind": str(row.get("role") or "note"),
        "importance": int(row.get("importance") or 0),
        "createdAt": _ms(row.get("created_at")),
        "updatedAt": _ms(row.get("updated_at")) or _ms(row.get("created_at")),
        "source": "server",
    }
    gone = _ms(row.get("deleted_at"))
    if gone:
        out["deletedAt"] = gone
        out["text"] = ""       # 消した物の中身は返さない（消したい理由は中身にある）
    return out


def push(items: List[Dict[str, Any]]) -> Tuple[int, int]:
    """端末から来た変更を書く。戻り値は (書いた数, 古くて捨てた数)。

    **新しいほうが勝つ**ので、先に手元の版を読んでから比べる。
    無条件に upsert すると、別の端末が後から入れた新しい記憶を、
    こちらの古い記憶で上書きしてしまう。
    """
    c = get_supabase()
    if c is None or not items:
        return (0, 0)

    rows = [r for r in (_clean(i) for i in items[:MAX_PUSH]) if r]
    if not rows:
        return (0, 0)

    # 手元にある同じ id の版を、まとめて1回で読む
    mine: Dict[str, int] = {}
    try:
        ids = [r["id"] for r in rows]
        have = (c.table("agent_memory")
                .select("id,updated_at")
                .in_("id", ids)
                .execute().data) or []
        for h in have:
            mine[str(h.get("id"))] = _ms(h.get("updated_at"))
    except Exception:
        # 読めなくても、書ける物は書く（合流そのものは進める）
        mine = {}

    fresh = [r for r in rows if _ms(r["updated_at"]) > mine.get(r["id"], -1)]
    stale = len(rows) - len(fresh)
    if not fresh:
        return (0, stale)

    try:
        c.table("agent_memory").upsert(fresh, on_conflict="id").execute()
        return (len(fresh), stale)
    except Exception:
        return (0, stale)


def pull(since_ms: int, limit: int = MAX_PULL) -> Tuple[List[Dict[str, Any]], bool]:
    """前回より後に変わったサーバー側の記憶。戻り値は (行, まだ続きがあるか)。"""
    c = get_supabase()
    if c is None:
        return ([], False)

    n = max(1, min(int(limit or MAX_PULL), MAX_PULL))
    since = _iso(since_ms) or _iso(1)          # 0 は「はじめから全部」
    try:
        rows = (c.table("agent_memory")
                .select("id,role,content,importance,created_at,updated_at,deleted_at")
                .eq("user_id", DEFAULT_USER_ID)
                .in_("role", list(SYNC_ROLES))
                .gt("updated_at", since)
                .order("updated_at", desc=False)
                .limit(n + 1)                  # 1件多く引いて「続きがあるか」を見る
                .execute().data) or []
    except Exception:
        return ([], False)

    more = len(rows) > n
    return ([_to_client(r) for r in rows[:n]], more)


def sync(since_ms: int, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """上げて、受け取る。画面はこの戻り値をそのまま出せばよい。

    `at` は**サーバーの時計**で返す。端末の時計を目印にすると、端末が
    少し進んでいるだけで「その間にサーバーへ入った記憶」を永久に取りこぼす。
    """
    c = get_supabase()
    if c is None:
        return {"ok": False,
                "reason": "保存先がつながっていないため、この端末の中だけになります。",
                "at": since_ms, "pushed": 0, "pulled": 0, "items": []}

    if not schema_ready(c):
        return {"ok": False,
                "reason": "データベースの表が古いため合流できません。"
                          "設定 → データベースの更新（supabase_schema.sql）を実行してください。",
                "at": since_ms, "pushed": 0, "pulled": 0, "items": []}

    # 受け取ってから、上げる。順番が逆だと、いま上げたばかりの物が
    # そのまま降ってくる（updated_at が since より新しいため）。
    # 害は無いが、毎回まるごと往復することになる。
    #
    # `started` を先に取るのは、この処理の**最中に**他の端末が書いた物を
    # 取りこぼさないため。同じ物を次回もう一度受け取ることはあるが、
    # 合流は何度やっても同じ結果になる（冪等）ので、取りこぼしより安い。
    started = now_ms()
    rows, more = pull(since_ms)
    pushed, stale = push(items or [])

    # 続きがあるときは、最後に受け取った物の時刻を次の目印にする。
    # ここでサーバーの「いま」を返すと、運びきれなかったぶんを飛ばしてしまう。
    if more and rows:
        at = max(1, int(rows[-1].get("updatedAt") or started) - 1)
    else:
        at = started

    return {"ok": True, "at": at, "more": more,
            "pushed": pushed, "stale": stale,
            "pulled": len(rows), "items": rows}
