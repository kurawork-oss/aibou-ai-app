# x_client.py — X（旧Twitter）へ実際に投稿する
# =====================================================================
# これまで SNS モードは文案を作るだけで、投稿は人が手で貼っていた。
# 「投稿できると思ったのにできない」という状態だったので、実装する。
#
# 認証は OAuth 1.0a（User Context）。X の開発者画面で4つの値を発行すれば
# その場で使えるので、OAuth の往復画面を作らずに済み、利用者の手間も少ない。
#   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
#
# 署名は標準ライブラリだけで作る（追加依存なし）。
#
# 安全側の決めごと:
#   ・人が押したときだけ投稿する。自動実行（エージェント/ワークフロー）からの
#     投稿は既定で止める（X_ALLOW_AUTOPOST=1 で解除）。取り返しがつかないため。
#   ・280字の判定は X の数え方に合わせる（日本語は1文字＝2）。
# =====================================================================

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.parse
import urllib.request
from typing import Dict

import keychain

API_URL = "https://api.x.com/2/tweets"
TIMEOUT = 20
LIMIT = 280

_KEYS = ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET")


def _k(name: str) -> str:
    try:
        return (keychain.get_key(name) or "").strip()
    except Exception:
        return ""


def configured() -> bool:
    """4つそろって初めて投稿できる。"""
    return all(_k(n) for n in _KEYS)


def missing_keys() -> list:
    """足りない値の名前。画面でそのまま案内できるように返す。"""
    return [n for n in _KEYS if not _k(n)]


# ── 文字数（Xの数え方） ─────────────────────────────────────────
def weighted_len(text: str) -> int:
    """Xの数え方に合わせた長さ。日本語などは1文字を2として数える。

    素朴に len() で数えると、日本語の投稿が「140字までしか入らない」のに
    280字入ると表示され、投稿してから弾かれる。
    """
    n = 0
    for ch in text or "":
        o = ord(ch)
        # 半角英数・記号はそのまま1。CJKや全角は2（Xの weighted length に準拠）
        if (0x0000 <= o <= 0x10FF) or (0x2000 <= o <= 0x200A) \
           or (0x2028 <= o <= 0x202F) or (0x2060 <= o <= 0x206F):
            n += 1
        else:
            n += 2
    return n


def fits(text: str) -> bool:
    return weighted_len(text) <= LIMIT


# ── OAuth 1.0a 署名 ─────────────────────────────────────────────
def _quote(s: str) -> str:
    return urllib.parse.quote(str(s), safe="~")


def _auth_header(method: str, url: str) -> str:
    """OAuth 1.0a のヘッダを組み立てる。

    本文がJSONのときは、署名対象に本文を含めない（OAuthの仕様どおり）。
    ここを間違えると 401 になり、原因が分かりにくい。
    """
    params: Dict[str, str] = {
        "oauth_consumer_key": _k("X_API_KEY"),
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": _k("X_ACCESS_TOKEN"),
        "oauth_version": "1.0",
    }
    base_params = "&".join(
        f"{_quote(k)}={_quote(params[k])}" for k in sorted(params)
    )
    base = "&".join([method.upper(), _quote(url), _quote(base_params)])
    signing_key = f'{_quote(_k("X_API_SECRET"))}&{_quote(_k("X_ACCESS_SECRET"))}'
    sig = base64.b64encode(
        hmac.new(signing_key.encode("ascii"), base.encode("ascii"), hashlib.sha1).digest()
    ).decode("ascii")
    params["oauth_signature"] = sig
    return "OAuth " + ", ".join(f'{_quote(k)}="{_quote(v)}"' for k, v in sorted(params.items()))


# ── 投稿 ─────────────────────────────────────────────────────────
def post(text: str, by_agent: bool = False) -> dict:
    """1件投稿する。{"ok":True,"id":...,"url":...} / {"error": 理由}。

    by_agent=True（自動実行からの呼び出し）は既定で止める。
    投稿は取り返しがつかないので、人が押したときだけにする。
    """
    text = (text or "").strip()
    if not text:
        return {"error": "投稿する文章が空です"}
    if not configured():
        miss = "・".join(missing_keys())
        return {"error": f"Xの連携が終わっていません（未設定: {miss}）。"
                         "管理 → もっと →「連携」→ X から設定してください"}
    if not fits(text):
        return {"error": f"{LIMIT}字を超えています"
                         f"（いまは{weighted_len(text)}字ぶん。日本語は1文字が2つ分に数えられます）"}
    if by_agent and (_k("X_ALLOW_AUTOPOST") or "").strip() not in ("1", "true", "True"):
        return {"error": "自動での投稿は既定で止めています。"
                         "画面の「Xに投稿」から、内容を確かめて押してください"}

    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=body, method="POST",
        headers={
            "Authorization": _auth_header("POST", API_URL),
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        return {"error": _explain_http(e.code, detail)}
    except Exception as e:
        return {"error": f"Xに繋がりませんでした: {e}"}

    tid = str((data.get("data") or {}).get("id") or "")
    if not tid:
        return {"error": f"投稿できませんでした: {str(data)[:200]}"}
    return {"ok": True, "id": tid, "url": f"https://x.com/i/web/status/{tid}"}


def _explain_http(code: int, detail: str) -> str:
    """Xが返す番号を、次にやることが分かる日本語にする。"""
    if code == 401:
        return ("Xが認証を受け付けませんでした。4つの値を貼り直してください。"
                "アプリの権限が「Read」のみだと投稿できません（Read and write にする）")
    if code == 403:
        return ("Xに拒否されました。アプリの権限が Read and write になっているか、"
                "同じ文面を続けて投稿していないかを確認してください")
    if code == 429:
        return "Xの投稿回数の上限に達しました。しばらく待ってからお試しください"
    if 500 <= code < 600:
        return "X側が不調です。しばらく待ってからお試しください"
    return f"投稿できませんでした（{code}）: {detail[:160]}"


def status() -> dict:
    """UIが「使えるか」を判断するための状態。値そのものは返さない。"""
    return {
        "configured": configured(),
        "missing": missing_keys(),
        "autopost_allowed": (_k("X_ALLOW_AUTOPOST") or "").strip() in ("1", "true", "True"),
        "limit": LIMIT,
    }
