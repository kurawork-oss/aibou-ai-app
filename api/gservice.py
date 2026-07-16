# gservice.py — Google 連携（OAuth 2.0 + Sheets / Docs）
# =====================================================================
# requests だけで実装（重い google クライアントライブラリ不要）。
# 無料枠で使える範囲：Google Sheets API / Docs API / Drive API。
#
# 認証情報（KEYCHAIN）:
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET … Google Cloud のOAuthクライアント
#   GOOGLE_REFRESH_TOKEN                     … 接続フローで自動保存される
#   GOOGLE_REDIRECT_URI (任意)               … 明示指定（Google Cloud登録と一致）
#
# 設計方針は他モジュールと統一：設定が欠けても絶対に crash しない。
# =====================================================================

import os

import keychain

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
# drive.file = このアプリが作成したファイルだけにアクセス（最小権限）。
SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
]


def _client_id() -> str:
    return (keychain.get_key("GOOGLE_CLIENT_ID") or "").strip()


def _client_secret() -> str:
    return (keychain.get_key("GOOGLE_CLIENT_SECRET") or "").strip()


def _refresh_token() -> str:
    return (keychain.get_key("GOOGLE_REFRESH_TOKEN") or "").strip()


def redirect_uri(default: str = "") -> str:
    """明示設定(GOOGLE_REDIRECT_URI)を最優先。無ければ default（呼び出し側が算出）。"""
    return (keychain.get_key("GOOGLE_REDIRECT_URI") or os.environ.get("GOOGLE_REDIRECT_URI", "") or default or "").strip()


def configured() -> bool:
    return bool(_client_id() and _client_secret())


def connected() -> bool:
    return bool(_refresh_token())


def status() -> dict:
    return {"configured": configured(), "connected": connected()}


def auth_url(redirect: str) -> str:
    from urllib.parse import urlencode
    params = {
        "client_id": _client_id(),
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",   # refresh_token を得る
        "prompt": "consent",        # 毎回同意 → refresh_token を確実に発行
        "include_granted_scopes": "true",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(code: str, redirect: str) -> dict:
    """認可コードを refresh_token に交換し、KEYCHAIN に保存する。"""
    if requests is None:
        return {"ok": False, "error": "requests が利用できません"}
    if not code:
        return {"ok": False, "error": "認可コードがありません"}
    try:
        r = requests.post(TOKEN_URL, data={
            "code": code,
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
        }, timeout=30)
        d = r.json() if r.content else {}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    rt = d.get("refresh_token")
    if rt:
        try:
            keychain.set_key("GOOGLE_REFRESH_TOKEN", rt)
        except Exception:
            pass
        return {"ok": True}
    return {"ok": False, "error": d.get("error_description") or d.get("error") or "refresh_token を取得できませんでした"}


def disconnect() -> dict:
    try:
        keychain.delete_key("GOOGLE_REFRESH_TOKEN")
    except Exception:
        pass
    return {"ok": True}


def _access_token():
    """refresh_token から access_token を取得。失敗時 None。"""
    if requests is None:
        return None
    rt = _refresh_token()
    if not (rt and configured()):
        return None
    try:
        r = requests.post(TOKEN_URL, data={
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "refresh_token": rt,
            "grant_type": "refresh_token",
        }, timeout=30)
        return (r.json() or {}).get("access_token")
    except Exception:
        return None


def _err_not_connected() -> dict:
    if not configured():
        return {"ok": False, "error": "Google未設定です（KEYCHAINでGOOGLE_CLIENT_ID/SECRETを設定）"}
    return {"ok": False, "error": "Google未接続です（Settings→Google連携で『接続』してください）"}


def create_sheet(title: str, rows) -> dict:
    """Google スプレッドシートを作成し rows を書き込む。{ok, url, id} / {ok:False, error}。"""
    tok = _access_token()
    if not tok:
        return _err_not_connected()
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    try:
        r = requests.post("https://sheets.googleapis.com/v4/spreadsheets",
                          headers=headers, json={"properties": {"title": title or "無題"}}, timeout=30)
        d = r.json() if r.content else {}
        sid = d.get("spreadsheetId")
        if not sid:
            return {"ok": False, "error": (d.get("error") or {}).get("message") or "作成に失敗しました"}
        url = d.get("spreadsheetUrl") or f"https://docs.google.com/spreadsheets/d/{sid}"
        values = []
        for row in (rows or []):
            cells = row if isinstance(row, (list, tuple)) else [row]
            values.append(["" if c is None else str(c) for c in cells])
        if values:
            requests.put(
                f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/A1",
                headers=headers, params={"valueInputOption": "RAW"},
                json={"values": values}, timeout=30)
        return {"ok": True, "url": url, "id": sid}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def create_doc(title: str, content: str) -> dict:
    """Google ドキュメントを作成し本文を挿入する。{ok, url, id} / {ok:False, error}。"""
    tok = _access_token()
    if not tok:
        return _err_not_connected()
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    try:
        r = requests.post("https://docs.googleapis.com/v1/documents",
                          headers=headers, json={"title": title or "無題"}, timeout=30)
        d = r.json() if r.content else {}
        did = d.get("documentId")
        if not did:
            return {"ok": False, "error": (d.get("error") or {}).get("message") or "作成に失敗しました"}
        if content:
            requests.post(
                f"https://docs.googleapis.com/v1/documents/{did}:batchUpdate",
                headers=headers,
                json={"requests": [{"insertText": {"location": {"index": 1}, "text": content}}]},
                timeout=30)
        return {"ok": True, "url": f"https://docs.google.com/document/d/{did}/edit", "id": did}
    except Exception as e:
        return {"ok": False, "error": str(e)}
