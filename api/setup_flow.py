"""
api/setup_flow.py — 足りない連携を、会話の中で繋いで、元の用事に戻る。

いま何が起きているか
--------------------
「Notionから資料探して」と頼まれても、Notionが繋がっていなければ道具は
「Notion未設定です」と返す。AIはそれをそのまま伝える。そこで会話は終わる。

利用者は、
  ・どこで設定するのか
  ・設定したら何ができるのか
  ・設定したあと、さっきの用事をもう一度言わないといけないのか
を自分で考えることになる。3つ目がいちばん効く。設定を終えて戻ってきたとき、
最初の頼みごとが消えているのは、単純に不親切。

ここでやること
--------------
1. 道具が「未接続だから無理」と言ったのを見つける
2. 何が足りないのかを判定する（Capability）
3. 元の頼みごとを預かって、連携の入口を返す
4. 連携が済んだら、預けた頼みごとをそのまま再開する

大事にしていること
------------------
・**設定で会話を終わらせない。** 預かった用事は、繋がった瞬間に自分で戻す
・**繋がっていない道具をAIから隠さない。** 隠すと「一番近い別の道具」を選んで
  「やりました」と答える（前にドライブで起きた）。呼ばせて、正直に失敗させ、
  その失敗を掴んで案内に変える
・**勝手に再開しない範囲を決める。** 取り返しのつかない操作（送信・投稿）は、
  設定が済んでも黙って実行しない。もう一度確かめる
"""

import json
import time
import uuid
from typing import Any, Dict, List, Optional

import config
import memstore

TABLE = "setup_sessions"

# 預かった用事の有効時間。連携の画面で迷う時間を見て、少し長め。
# これを過ぎたものは、黙って捨てる（何日も前の頼みごとが突然動くのは怖い）。
HOLD_TTL = 30 * 60

# 設定が済んでも、自動では再開しないもの。
# 取り返しがつかないので、繋がった直後に黙って実行してはいけない。
NEVER_AUTO_RESUME = {"send_email", "notify", "enqueue_income", "run_automation"}

_mem = memstore.TenantList()


def _now() -> float:
    return time.time()


# ── 「未接続で無理だった」を見つける ─────────────────────────────────
# 道具は失敗を日本語の文で返す（例外を投げない作りにしてある）。
# その文から、どの連携が足りないのかを読む。
_SIGNS: List[tuple] = [
    ("google", ("Google未設定", "Google未接続", "Google連携が必要",
                "Google連携の期限")),
    ("slack", ("Slackのトークン", "Slackの読み取りが未設定", "SLACK_BOT_TOKEN")),
    ("notion", ("NOTION_TOKEN", "Notion未設定", "Notionのトークン")),
    ("github", ("GITHUB_TOKEN", "GitHub未設定")),
]


def detect(result: str) -> str:
    """道具の返した文から、足りない連携を読む。分からなければ空文字。"""
    text = (result or "")
    if not text:
        return ""
    for provider, signs in _SIGNS:
        if any(s in text for s in signs):
            return provider
    return ""


def _provider_info(provider: str) -> dict:
    try:
        import oauth
        return oauth.status(provider) or {}
    except Exception:
        return {}


# ── 用事を預かる ─────────────────────────────────────────────────────
def hold(instruction: str, provider: str, tool: str = "",
         params: Optional[dict] = None) -> dict:
    """元の頼みごとを預かる。連携が済んだら、これを戻す。"""
    instruction = (instruction or "").strip()
    if not (instruction and provider):
        return {"error": "預かるものがありません"}
    row = {
        "id": str(uuid.uuid4()),
        "provider": provider,
        "instruction": instruction[:2000],
        "tool": (tool or "")[:60],
        "params": json.dumps(params or {}, ensure_ascii=False)[:4000],
        "status": "waiting",
        "created_at": _now(),
    }
    _mem.insert(0, row)
    c = config.get_supabase()
    if c:
        try:
            c.table(TABLE).insert(row).execute()
        except Exception:
            pass          # 残らなくても、この場の会話では使える
    return row


def _rows() -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            got = (c.table(TABLE).select("*").eq("status", "waiting")
                   .order("created_at", desc=True).limit(20).execute().data)
            if got is not None:
                return got
        except Exception:
            pass
    return [r for r in _mem if r.get("status") == "waiting"]


def _drop(row_id: str, status: str = "resumed") -> None:
    for r in _mem:
        if r.get("id") == row_id:
            r["status"] = status
    c = config.get_supabase()
    if c:
        try:
            c.table(TABLE).update({"status": status}).eq("id", row_id).execute()
        except Exception:
            pass


def pending(provider: str = "") -> Optional[dict]:
    """預かってある用事のうち、いちばん新しいもの。古すぎるものは捨てる。"""
    for r in _rows():
        try:
            age = _now() - float(r.get("created_at") or 0)
        except Exception:
            age = 0
        if age > HOLD_TTL:
            _drop(r.get("id", ""), "expired")
            continue
        if provider and r.get("provider") != provider:
            continue
        return r
    return None


def take(provider: str) -> Optional[dict]:
    """預かってある用事を取り出す（取り出したら、もう戻さない）。"""
    row = pending(provider)
    if not row:
        return None
    _drop(row.get("id", ""), "resumed")
    try:
        row["params"] = json.loads(row.get("params") or "{}")
    except Exception:
        row["params"] = {}
    return row


def can_auto_resume(row: dict) -> bool:
    """黙って再開してよい用事か。

    送信・投稿のような取り返しのつかないものは、繋がった直後に自動で
    走らせない。「連携したら勝手にメールが飛んだ」がいちばん怖い。
    """
    return (row or {}).get("tool", "") not in NEVER_AUTO_RESUME


# ── 案内の文を作る ───────────────────────────────────────────────────
def guidance(provider: str, instruction: str = "") -> dict:
    """「なぜできないか・何をすればいいか」を返す。

    仕様書の言うとおり、「できません」で終わらせない。
      1. なぜできないのか
      2. 繋ぐと何ができるようになるのか
      3. いま繋ぐか
    を並べる。
    """
    info = _provider_info(provider)
    label = info.get("label") or provider
    unlocks = info.get("unlocks") or []

    if not info:
        return {"provider": provider, "label": label, "can_connect": False,
                "message": f"{label}に繋がっていないため、この用事は進められません。"}

    if not info.get("configured"):
        # 利用者では直せないこと（アプリ登録）。そう言わないと、自分の設定を
        # 探して詰まる。
        return {
            "provider": provider, "label": label, "can_connect": False,
            "needs_owner": True,
            "message": (f"{label}に繋がっていないため、この用事は進められません。"
                        f"このアプリの持ち主が{label}へのアプリ登録をまだ済ませて"
                        "いないので、いまは繋ぐこともできません。"),
        }

    lines = [f"{label}に繋がっていないため、この用事は進められません。"]
    if unlocks:
        lines.append(f"繋ぐと、{'・'.join(unlocks[:3])}ができるようになります。")
    if instruction:
        lines.append(f"繋いだあと、「{instruction[:60]}」を続けます。")
    lines.append("いま繋ぎますか？")

    return {
        "provider": provider, "label": label, "can_connect": True,
        "connect_path": f"/connect/{provider}/start",
        "unlocks": unlocks,
        "message": "".join(lines),
    }


def blocked(instruction: str, tool: str, params: Optional[dict],
            result: str) -> Optional[dict]:
    """道具の失敗が「連携が足りないだけ」なら、案内と預かりを用意する。

    そうでない失敗（本当のエラー）には手を出さない。ここで何でも
    「設定すれば直る」と言い出すと、原因の取り違えを増やす。
    """
    provider = detect(result)
    if not provider:
        return None
    g = guidance(provider, instruction)
    if g.get("can_connect"):
        held = hold(instruction, provider, tool, params)
        g["held_id"] = held.get("id", "")
    return g


def status() -> dict:
    """画面用。いま預かっている用事があるか。"""
    row = pending()
    if not row:
        return {"waiting": False}
    return {
        "waiting": True,
        "provider": row.get("provider", ""),
        "instruction": row.get("instruction", ""),
        "auto_resume": can_auto_resume(row),
    }
