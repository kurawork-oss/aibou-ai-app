"""
audit.py — AIbou があなたの代わりに「外で」したことを残す（操作の記録）。

なぜ要るか
----------
手元のパソコンの相棒、あなたとして押すブラウザ、保存した手順、メールの送信。
AIbou があなたの代わりに外で何かをしたことは、あとから辿れないと困る:

  ・身に覚えのない送信があったとき、AIbou がやったのかどうか分からない
  ・「今朝の手順は流れた？」に答えられない
  ・確認して押したのか、確認なしで動いたのかが分からない

何を残すか
----------
**実行したら必ず1行残す**のは、次の2種類:

  ・外に何かが残る・起きる道具（段階2以上。メール・予定・ドライブ…）
  ・手元の相棒・ブラウザ・手順の道具（段階に関わらず。あなたの持ち物に触る）

読むだけの道具（検索など）は残さない。全部残すと、肝心の行が埋もれる。

1行に入れるもの:

    いつ / どこから頼まれたか（会話・実行モード・承認ボタン・通知・定期実行・#）
    / 何を（道具） / 何に（URL・ファイル・手順の名前・宛先）
    / どこで（手元の台・ブラウザ） / どう通したか（確認して・確認なし・段階）
    / 結果（できた・できなかった＋1行）

残さない物
----------
**本文は残さない**（メールの中身・ファイルの中身・ページの本文）。残すと、
ここがいちばん漏れて困る場所になる。宛先やURLに鍵らしい物が混ざっていたら
伏せる（secrets_guard.redact）。
"""

from __future__ import annotations

import contextvars
import time
import uuid
from contextlib import contextmanager
from typing import List, Optional

import config
import memstore
import secrets_guard

TABLE = "audit_log"
#: 保存先が無いときに手元に持っておく行数（古い物から落とす）
MAX_MEM = 500
#: 画面に一度に出す行数の上限
MAX_LIST = 200

#: 段階に関わらず、実行したら必ず残す道具（あなたの持ち物に触る物）
ALWAYS = frozenset({
    "local_list", "local_read", "local_write", "local_append", "obsidian_note",
    "browser_open", "browser_act",
    "recipe_run", "recipe_save", "recipe_delete",
})

#: どこから頼まれたか（画面に出す言葉）
SOURCES = {
    "chat": "会話",
    "agent": "実行モード",
    "approve": "承認ボタン",
    "push": "通知から承認",
    "schedule": "定期実行",
    "command": "#コマンド",
    "direct": "その他",
}

# 結果の文から「できなかった」を拾う目印（道具が明示しなかったときだけ使う）
_FAIL = ("失敗", "エラー", "できません", "ませんでした", "不明なツール", "が空です",
         "見つかりません", "ありません", "断りました", "止めました", "流しきれません",
         "繋がっていません", "動いていません", "実行していません")

_mem = memstore.TenantList()

# 頼まれた道筋（確認の門が置く）
_route: contextvars.ContextVar = contextvars.ContextVar("audit_route", default=None)
# いま実行している1件（道具が「どこで」「できたか」を書き込む）
_current: contextvars.ContextVar = contextvars.ContextVar("audit_current", default=None)


def _now() -> float:
    return time.time()


@contextmanager
def route(source: str, instruction: str = "", approved: bool = False):
    """この中で動く道具は、`source` から頼まれた物として残る。

    approved は「人が確認カードを見て押したか」。門を素通りした物（段階が
    軽い・承認モードを切っている）は False のまま残る——あとから「確認なしで
    動いた物」を拾えるように。
    """
    token = _route.set({"source": source if source in SOURCES else "direct",
                        "instruction": instruction or "", "approved": bool(approved)})
    try:
        yield
    finally:
        _route.reset(token)


def should_record(tool: str, level: int) -> bool:
    return tool in ALWAYS or int(level) >= 2


def begin(tool: str, params: Optional[dict]) -> dict:
    """1件の実行を始める。返した物を end() に渡す。"""
    rec = {"tool": tool, "params": params or {}, "where": "", "ok": None,
           "token": None}
    rec["token"] = _current.set(rec)
    return rec


def note(ok: Optional[bool] = None, where: str = "") -> None:
    """道具の中から「どこで動いたか」「できたか」を書き込む（無ければ何もしない）。"""
    rec = _current.get()
    if rec is None:
        return
    if ok is not None:
        rec["ok"] = bool(ok)
    if where:
        rec["where"] = where


def _target(tool: str, params: dict) -> str:
    """何に対しての操作か。**本文は入れない**（宛先・URL・パス・名前だけ）。"""
    for key in ("url", "path", "name", "to", "title", "query"):
        v = params.get(key)
        if v:
            return str(v)
    if tool == "obsidian_note":
        return "今日の日誌"
    return ""


def _looks_failed(result: str) -> bool:
    return any(m in (result or "") for m in _FAIL)


def end(rec: dict, result: str, level: Optional[int] = None) -> Optional[dict]:
    """実行を終える。残すべき物なら1行残して、その行を返す。"""
    try:
        _current.reset(rec.get("token"))
    except Exception:
        pass
    tool = rec.get("tool") or ""
    if level is None:
        try:
            import risk
            level = risk.LEVELS.get(tool, risk.UNKNOWN)
        except Exception:
            level = 3
    if not should_record(tool, level):
        return None
    ctx = _route.get() or {}
    ok = rec["ok"] if rec.get("ok") is not None else not _looks_failed(result)
    first = next((ln.strip() for ln in (result or "").splitlines() if ln.strip()), "")
    row = {
        "id": uuid.uuid4().hex,
        "at": _now(),
        "source": ctx.get("source") or "direct",
        "instruction": secrets_guard.redact(str(ctx.get("instruction") or ""))[:200],
        "tool": tool,
        "target": secrets_guard.redact(_target(tool, rec.get("params") or {}))[:200],
        "where": str(rec.get("where") or "")[:120],
        "level": int(level),
        "approved": bool(ctx.get("approved")),
        "ok": bool(ok),
        "summary": secrets_guard.redact(first)[:200],
    }
    _save(row)
    return row


def _save(row: dict) -> str:
    _mem.append(row)
    while len(_mem) > MAX_MEM:
        del _mem[0]
    c = config.get_supabase()
    if c:
        try:
            c.table(TABLE).insert(row).execute()
            return "db"
        except Exception:
            pass
    return "memory"


def recent(limit: int = 50) -> List[dict]:
    """新しい順。保存先が読めなければ、手元の控え。"""
    n = max(1, min(int(limit or 50), MAX_LIST))
    c = config.get_supabase()
    if c:
        try:
            rows = c.table(TABLE).select("*").order("at", desc=True).limit(n).execute().data
            if rows is not None:
                return rows
        except Exception:
            pass
    return sorted(list(_mem), key=lambda r: -float(r.get("at") or 0))[:n]


def label_of(source: str) -> str:
    return SOURCES.get(source or "", SOURCES["direct"])
