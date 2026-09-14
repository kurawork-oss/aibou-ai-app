"""
api/oauth.py — 「押すだけ」の外部連携（OAuth 2.0）。

なぜ作るか
----------
これまで外部サービスは、利用者がトークンを発行して貼り付ける形だった。
Slack の Bot トークン、Notion のインテグレーション、GitHub の PAT、
Google の Client ID/Secret……。どれも手順が長く、いちばん脱落する所だった。

Claude などが「Googleでログイン」だけで繋がるのは、提供元にアプリを
一度だけ登録してあり、その登録情報（client_id / secret）を提供元の
サーバーが持っているから。利用者が鍵を持たないのではなく、
アプリの作り手が代わりに持っている。

ここも同じにする。アプリ登録はこのアプリの持ち主が1回だけ行い、
client_id / secret はサーバーの環境変数に置く。利用者は「連携」を
押して許可するだけ。

いちばん大事な直し（持ち主の取り違え）
--------------------------------------
提供元からの戻り（コールバック）は、提供元のサーバーがブラウザを
飛ばしてくるだけなので、ログイン情報が付いていない。これまでの
/google/auth/callback は利用者を特定できないまま鍵を保存していた。
その結果 keychain が「1人運用」とみなして os.environ に書き、
サーバー全体の既定値になっていた。

  → 誰か1人がGoogleを繋ぐと、自分で繋いでいない他の利用者が全員
     その人のGoogleアカウントで動く（カレンダーを読み、ドライブに書く）

そこで、送り出すときに「誰が始めたか」を署名して state に載せ、
戻ってきたときに検証して、その人の保管庫にだけ保存する。
署名があるので、他人が state を作って別のアカウントを差し込むこともできない
（OAuth で state を付ける本来の目的でもある）。
"""

import base64
import hashlib
import hmac
import json
import time
from typing import Dict, List, Optional
from urllib.parse import urlencode

import config
import keychain

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

# state の有効時間。同意画面で迷う時間を見て少し長め。
STATE_TTL = 15 * 60
_TIMEOUT = 30


# ── 提供元の定義 ─────────────────────────────────────────────────────
# 追加するときは、ここに1つ足すだけでよい（手書きの実装を増やさない）。
PROVIDERS: Dict[str, dict] = {
    "google": {
        "label": "Google",
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "scopes": [
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/presentations",
            "https://www.googleapis.com/auth/calendar.events",
            # メールを読む。これがあると、アプリパスワードを作る手順が要らなくなる。
            "https://www.googleapis.com/auth/gmail.readonly",
        ],
        "scope_sep": " ",
        # access_type=offline と prompt=consent が無いと refresh_token が来ない
        "extra_auth": {"access_type": "offline", "prompt": "consent",
                       "include_granted_scopes": "true"},
        "client_id_env": "GOOGLE_CLIENT_ID",
        "client_secret_env": "GOOGLE_CLIENT_SECRET",
        "refreshable": True,
        # 以前の保存名。すでに繋いでいる人が繋ぎ直さずに済むように読む。
        "legacy_refresh_key": "GOOGLE_REFRESH_TOKEN",
        "unlocks": ["カレンダーの読み書き", "スプレッドシート・ドキュメント・スライドの作成",
                    "ドライブにファイルを作る", "受信メールを読む"],
        "note": "Googleの審査を受けるまでは、同意画面に「確認されていません」と出ます"
                "（自分と身内で使うぶんには、そのまま進めて問題ありません）。",
    },
    "slack": {
        "label": "Slack",
        "auth_url": "https://slack.com/oauth/v2/authorize",
        "token_url": "https://slack.com/api/oauth.v2.access",
        "scopes": ["channels:history", "channels:read", "groups:history", "groups:read",
                   "im:history", "im:read", "mpim:history", "mpim:read",
                   "users:read", "chat:write"],
        "scope_sep": ",",
        "extra_auth": {},
        "client_id_env": "SLACK_CLIENT_ID",
        "client_secret_env": "SLACK_CLIENT_SECRET",
        "refreshable": False,
        "unlocks": ["チャンネルの発言を見張る", "結果をチャンネルに投稿する"],
    },
    "notion": {
        "label": "Notion",
        "auth_url": "https://api.notion.com/v1/oauth/authorize",
        "token_url": "https://api.notion.com/v1/oauth/token",
        "scopes": [],
        "scope_sep": " ",
        "extra_auth": {"owner": "user"},
        "client_id_env": "NOTION_CLIENT_ID",
        "client_secret_env": "NOTION_CLIENT_SECRET",
        "refreshable": False,
        "token_auth": "basic",      # client_id:secret を Authorization に載せる
        "token_format": "json",
        "unlocks": ["決めたページにメモを書き足す"],
    },
    "github": {
        "label": "GitHub",
        "auth_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "scopes": ["repo"],
        "scope_sep": " ",
        "extra_auth": {},
        "client_id_env": "GITHUB_CLIENT_ID",
        "client_secret_env": "GITHUB_CLIENT_SECRET",
        "refreshable": False,
        "unlocks": ["リポジトリを読む・書く（CODEモード）", "ルールのメモを取り込む"],
    },
}

# OAuth が使えないもの。画面に「なぜ手入力なのか」を出すために持っておく。
NO_OAUTH = {
    "GEMINI_API_KEY": "AIの利用料の請求先そのものなので、代理で持てません。",
    "OPENAI_API_KEY": "AIの利用料の請求先そのものなので、代理で持てません。",
    "HUGGINGFACE_TOKEN": "AIの利用料の請求先そのものなので、代理で持てません。",
    "LINE_CHANNEL_TOKEN": "LINE公式アカウントは1人に1つで、代理で作れません。",
}


def _p(provider: str) -> Optional[dict]:
    return PROVIDERS.get((provider or "").strip().lower())


def _store_key(provider: str) -> str:
    return f"OAUTH_{provider.upper()}"


# ── アプリ登録（持ち主が1回だけ行う） ────────────────────────────────
def _app_credentials(provider: str) -> tuple:
    """(client_id, client_secret)。サーバーの環境変数 → その人の保管庫の順。

    素の環境変数を先に見るのは、ここが「アプリの登録情報」だから。
    利用者ごとに違う物ではなく、このアプリ自身の身分証にあたる。
    """
    p = _p(provider)
    if not p:
        return "", ""
    cid = (keychain.get_key(p["client_id_env"]) or "").strip()
    sec = (keychain.get_key(p["client_secret_env"]) or "").strip()
    return cid, sec


def configured(provider: str) -> bool:
    cid, sec = _app_credentials(provider)
    return bool(cid and sec)


# ── 「誰が始めたか」を署名して運ぶ ───────────────────────────────────
def _secret() -> str:
    return (getattr(config, "KEYCHAIN_SECRET", "") or config.SUPABASE_SERVICE_KEY
            or config.APP_TOKEN or "")


def sign_state(user_id: str, provider: str, owner: bool = False) -> str:
    """state を作る。中身は隠さないが、書き換えられないようにする。

    ここを署名なしにすると、他人に細工したURLを踏ませて、その人のAIbouに
    こちらのアカウントを繋がせることができてしまう（OAuthでstateを付ける
    本来の理由）。

    owner も載せるのは、戻ってきたときに「保存先をどう束ねるか」を決めるため。
    持ち主は保存先を繋いでいなくてもサーバー既定のDBを使うが、それ以外の人は
    保存先が無いなら断らなければならない（断らないとプロセスへ書いてしまい、
    サーバー全体の既定値になる）。戻りには本人確認が付かないので、
    送り出すときに分かっているこの情報を、署名して持たせる。
    """
    payload = json.dumps({"u": user_id or "", "p": provider, "o": bool(owner),
                          "t": int(time.time())},
                         separators=(",", ":"), ensure_ascii=False).encode()
    body = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    secret = _secret()
    if not secret:
        # 署名できない構成（1人運用・鍵なし）。持ち主しかいないので中身だけ返す。
        return body
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def verify_state(state: str, provider: str) -> dict:
    """state を検証して {"ok":True,"user_id":...} / {"error":...} を返す。"""
    s = (state or "").strip()
    if not s:
        return {"error": "state がありません"}
    body, _, sig = s.partition(".")
    secret = _secret()
    if secret:
        if not sig:
            return {"error": "state に署名がありません"}
        want = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(want, sig):
            return {"error": "state の署名が合いません"}
    try:
        pad = "=" * (-len(body) % 4)
        data = json.loads(base64.urlsafe_b64decode(body + pad))
    except Exception:
        return {"error": "state を読み取れません"}
    if data.get("p") != provider:
        return {"error": "state の提供元が違います"}
    if time.time() - int(data.get("t") or 0) > STATE_TTL:
        return {"error": "時間が経ちすぎました。もう一度お試しください"}
    return {"ok": True, "user_id": str(data.get("u") or ""),
            "owner": bool(data.get("o"))}


# ── 送り出す ─────────────────────────────────────────────────────────
def start_url(provider: str, redirect: str, user_id: str = "",
              owner: bool = False) -> dict:
    p = _p(provider)
    if not p:
        return {"error": f"知らない連携先です（{provider}）"}
    cid, _sec = _app_credentials(provider)
    if not cid:
        return {"error": f"{p['label']} のアプリ登録がまだです。"
                         f"サーバーに {p['client_id_env']} と {p['client_secret_env']} を"
                         "設定してください（このアプリの持ち主が1回だけ行う作業です）"}
    params = {
        "client_id": cid,
        "redirect_uri": redirect,
        "response_type": "code",
        "state": sign_state(user_id, provider, owner),
    }
    if p["scopes"]:
        params["scope"] = p["scope_sep"].join(p["scopes"])
    params.update(p.get("extra_auth") or {})
    return {"ok": True, "url": f"{p['auth_url']}?{urlencode(params)}"}


# ── 受け取る ─────────────────────────────────────────────────────────
def _exchange(provider: str, code: str, redirect: str) -> dict:
    """認可コードをトークンに替える。提供元ごとの作法の違いはここだけ。"""
    p = _p(provider)
    cid, sec = _app_credentials(provider)
    if requests is None:
        return {"error": "requests が利用できません"}
    data = {"code": code, "redirect_uri": redirect, "grant_type": "authorization_code"}
    headers = {"Accept": "application/json"}
    if p.get("token_auth") == "basic":
        basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    else:
        data["client_id"] = cid
        data["client_secret"] = sec
    try:
        if p.get("token_format") == "json":
            r = requests.post(p["token_url"], json=data, headers=headers, timeout=_TIMEOUT)
        else:
            r = requests.post(p["token_url"], data=data, headers=headers, timeout=_TIMEOUT)
        d = r.json() if r.content else {}
    except Exception as e:
        return {"error": f"{p['label']} に繋がりませんでした（{str(e)[:120]}）"}
    if d.get("error") or (provider == "slack" and not d.get("ok")):
        return {"error": str(d.get("error_description") or d.get("error") or "交換に失敗しました")}
    return {"ok": True, "raw": d}


def _record_from(provider: str, d: dict) -> dict:
    """提供元の応答を、こちらの保存する形に揃える。"""
    rec = {
        "access_token": d.get("access_token") or "",
        "refresh_token": d.get("refresh_token") or "",
        "obtained_at": int(time.time()),
        "expires_in": int(d.get("expires_in") or 0),
        "account": "",
    }
    if provider == "slack":
        # v2 は bot トークンが上位、team 名も一緒に返る
        rec["account"] = ((d.get("team") or {}).get("name") or "")
    elif provider == "notion":
        rec["account"] = d.get("workspace_name") or ""
    return rec


def finish(provider: str, code: str, redirect: str) -> dict:
    """コードを受け取り、いま束ねている保存先（＝その人の保管庫）に入れる。

    呼ぶ側が、先に verify_state で持ち主を割り出して束ねておくこと。
    """
    p = _p(provider)
    if not p:
        return {"error": f"知らない連携先です（{provider}）"}
    if not code:
        return {"error": "認可コードがありません"}
    res = _exchange(provider, code, redirect)
    if res.get("error"):
        return res

    d = res["raw"]
    rec = _record_from(provider, d)
    if p["refreshable"] and not rec["refresh_token"]:
        return {"error": "更新用のトークンが返りませんでした。"
                         "連携済みのアプリを一度解除してから、もう一度お試しください"}
    if not (rec["access_token"] or rec["refresh_token"]):
        return {"error": "トークンが返りませんでした"}

    if not rec["account"]:
        rec["account"] = _whoami(provider, rec.get("access_token") or "")

    saved = keychain.set_key(_store_key(provider), json.dumps(rec, ensure_ascii=False))
    if saved.get("error"):
        return {"error": saved["error"]}
    out = {"ok": True, "account": rec["account"], "persisted": saved.get("persisted", False)}
    if not out["persisted"]:
        out["warning"] = ("いまは使えますが、保存先が無いのでサーバーの更新で消えます。"
                          "管理 → もっと →「連携」→ Supabase から自分のデータベースを接続してください。")
    return out


# ── 使う ─────────────────────────────────────────────────────────────
def _load(provider: str) -> Optional[dict]:
    raw = (keychain.get_key(_store_key(provider)) or "").strip()
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    # 以前の形（Googleだけ）。繋ぎ直さずに済むように読む。
    p = _p(provider) or {}
    legacy = p.get("legacy_refresh_key")
    if legacy:
        rt = (keychain.get_key(legacy) or "").strip()
        if rt:
            return {"access_token": "", "refresh_token": rt, "obtained_at": 0,
                    "expires_in": 0, "account": ""}
    return None


def connected(provider: str) -> bool:
    return _load(provider) is not None


def access_token(provider: str) -> str:
    """使えるアクセストークン。期限切れなら更新する。取れなければ空文字。"""
    p = _p(provider)
    rec = _load(provider)
    if not (p and rec):
        return ""

    if not p["refreshable"]:
        return rec.get("access_token") or ""

    # 期限に少し余裕を持たせる（送信の途中で切れないように）
    fresh = (rec.get("access_token")
             and rec.get("obtained_at")
             and time.time() < rec["obtained_at"] + max(0, rec.get("expires_in", 0)) - 60)
    if fresh:
        return rec["access_token"]

    rt = rec.get("refresh_token")
    cid, sec = _app_credentials(provider)
    if not (rt and cid and sec and requests is not None):
        return ""
    try:
        r = requests.post(p["token_url"], data={
            "client_id": cid, "client_secret": sec,
            "refresh_token": rt, "grant_type": "refresh_token",
        }, timeout=_TIMEOUT)
        d = r.json() if r.content else {}
    except Exception:
        return ""
    at = d.get("access_token") or ""
    if not at:
        return ""
    rec["access_token"] = at
    rec["obtained_at"] = int(time.time())
    rec["expires_in"] = int(d.get("expires_in") or 0)
    try:
        keychain.set_key(_store_key(provider), json.dumps(rec, ensure_ascii=False))
    except Exception:
        pass          # 保存に失敗しても、いま得たトークンは使える
    return at


def _whoami(provider: str, token: str) -> str:
    """繋いだ先のアカウント名。取れなければ空文字（繋がったことは変わらない）。

    どのアカウントに繋がっているかを画面に出せると、「作ったはずなのに無い」が
    実は別アカウントだった、という取り違えにその場で気づける。
    """
    if not token or requests is None:
        return ""
    try:
        if provider == "google":
            r = requests.get("https://www.googleapis.com/drive/v3/about",
                             params={"fields": "user(emailAddress)"},
                             headers={"Authorization": f"Bearer {token}"}, timeout=15)
            return ((r.json().get("user") or {}).get("emailAddress") or "") if r.content else ""
        if provider == "github":
            r = requests.get("https://api.github.com/user",
                             headers={"Authorization": f"Bearer {token}",
                                      "Accept": "application/vnd.github+json"}, timeout=15)
            return (r.json().get("login") or "") if r.content else ""
        if provider == "slack":
            r = requests.get("https://slack.com/api/auth.test",
                             headers={"Authorization": f"Bearer {token}"}, timeout=15)
            d = r.json() if r.content else {}
            return d.get("team") or "" if d.get("ok") else ""
    except Exception:
        return ""
    return ""


def disconnect(provider: str) -> dict:
    keychain.delete_key(_store_key(provider))
    p = _p(provider) or {}
    if p.get("legacy_refresh_key"):
        keychain.delete_key(p["legacy_refresh_key"])
    return {"ok": True}


def status(provider: str) -> dict:
    p = _p(provider)
    if not p:
        return {"error": f"知らない連携先です（{provider}）"}
    rec = _load(provider)
    out = {
        "key": provider, "label": p["label"],
        "configured": configured(provider),      # 持ち主がアプリ登録を済ませたか
        "connected": rec is not None,            # この人が許可を済ませたか
        "unlocks": p.get("unlocks") or [],
    }
    if p.get("note"):
        out["note"] = p["note"]
    if rec:
        out["account"] = rec.get("account") or ""
    return out


def status_all() -> List[dict]:
    return [status(k) for k in PROVIDERS]
