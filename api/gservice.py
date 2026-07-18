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
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/calendar.events",
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


# ── Google Slides ────────────────────────────────────────────────────
# テーマ名 → スライド背景色（RGB 0-1）。Google スライドにも配色を反映する。
_THEME_BG = {
    "midnight": {"red": 0.055, "green": 0.086, "blue": 0.15},
    "aurora": {"red": 0.024, "green": 0.137, "blue": 0.122},
    "sunset": {"red": 0.165, "green": 0.063, "blue": 0.125},
    "forge": {"red": 0.04, "green": 0.055, "blue": 0.086},
    "mono": {"red": 0.96, "green": 0.96, "blue": 0.97},
}


def _slide_body(s: dict) -> str:
    """レイアウトに関わらず、本文として見せるテキストを組み立てる。"""
    parts = []
    if s.get("subtitle"):
        parts.append(str(s["subtitle"]))
    if s.get("stat"):
        parts.append(str(s["stat"]))
    for b in (s.get("bullets") or []):
        if str(b).strip():
            parts.append(str(b))
    if s.get("quote"):
        parts.append(f"“{s['quote']}”")
    if s.get("author"):
        parts.append(f"— {s['author']}")
    return "\n".join(parts)


def create_presentation(title: str, slides, theme: str = "") -> dict:
    """Google スライドを作成する。slides=[{layout,title,bullets,...}]。{ok, url, id}。"""
    tok = _access_token()
    if not tok:
        return _err_not_connected()
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    slides = slides or []
    bg = _THEME_BG.get((theme or "").strip().lower())
    try:
        r = requests.post("https://slides.googleapis.com/v1/presentations",
                          headers=headers, json={"title": title or "無題のプレゼン"}, timeout=30)
        d = r.json() if r.content else {}
        pid = d.get("presentationId")
        if not pid:
            return {"ok": False, "error": (d.get("error") or {}).get("message") or "作成に失敗しました"}
        first_slide_id = (d.get("slides") or [{}])[0].get("objectId")

        reqs = []
        for i, s in enumerate(slides[:30]):
            s = s or {}
            sid, tid, bid = f"s_{i}", f"t_{i}", f"b_{i}"
            reqs.append({
                "createSlide": {
                    "objectId": sid,
                    "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"},
                    "placeholderIdMappings": [
                        {"layoutPlaceholder": {"type": "TITLE"}, "objectId": tid},
                        {"layoutPlaceholder": {"type": "BODY"}, "objectId": bid},
                    ],
                }
            })
            # 背景色（テーマ）を適用
            if bg:
                reqs.append({"updatePageProperties": {
                    "objectId": sid,
                    "pageProperties": {"pageBackgroundFill": {"solidFill": {"color": {"rgbColor": bg}}}},
                    "fields": "pageBackgroundFill.solidFill.color",
                }})
            stitle = str(s.get("title") or s.get("quote") or s.get("stat") or "")[:200]
            if stitle:
                reqs.append({"insertText": {"objectId": tid, "text": stitle}})
            body = _slide_body(s) if (s.get("title") or s.get("subtitle") or s.get("bullets")) else ""
            if body:
                reqs.append({"insertText": {"objectId": bid, "text": body}})
                if s.get("bullets"):
                    reqs.append({"createParagraphBullets": {
                        "objectId": bid,
                        "textRange": {"type": "ALL"},
                        "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE",
                    }})
        if first_slide_id and reqs:
            reqs.append({"deleteObject": {"objectId": first_slide_id}})

        if reqs:
            requests.post(f"https://slides.googleapis.com/v1/presentations/{pid}:batchUpdate",
                          headers=headers, json={"requests": reqs}, timeout=45)
        return {"ok": True, "url": f"https://docs.google.com/presentation/d/{pid}/edit", "id": pid}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Google Calendar ──────────────────────────────────────────────────
_JST = None


def _jst():
    global _JST
    if _JST is None:
        from datetime import timezone, timedelta
        _JST = timezone(timedelta(hours=9))
    return _JST


def create_event(title: str, date: str, time: str = "", duration_min: int = 60) -> dict:
    """Google カレンダー（primary）に予定を追加する。date=YYYY-MM-DD, time=HH:MM。
    time 省略時は終日予定。{ok, url, id} / {ok:False, error}。"""
    tok = _access_token()
    if not tok:
        return _err_not_connected()
    from datetime import datetime, timedelta
    date = (date or "").strip()
    time = (time or "").strip()
    if not date:
        return {"ok": False, "error": "日付(date=YYYY-MM-DD)が必要です"}
    try:
        if time:
            start_dt = datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M").replace(tzinfo=_jst())
            end_dt = start_dt + timedelta(minutes=int(duration_min or 60))
            body = {
                "summary": title or "予定",
                "start": {"dateTime": start_dt.isoformat(), "timeZone": "Asia/Tokyo"},
                "end": {"dateTime": end_dt.isoformat(), "timeZone": "Asia/Tokyo"},
            }
        else:
            d = datetime.strptime(date, "%Y-%m-%d")
            body = {
                "summary": title or "予定",
                "start": {"date": date},
                "end": {"date": (d + timedelta(days=1)).strftime("%Y-%m-%d")},  # end.date は排他
            }
    except Exception as e:
        return {"ok": False, "error": f"日付/時刻の形式が不正です：{e}"}
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    try:
        r = requests.post("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                          headers=headers, json=body, timeout=30)
        d = r.json() if r.content else {}
        if not d.get("id"):
            return {"ok": False, "error": (d.get("error") or {}).get("message") or "作成に失敗しました"}
        return {"ok": True, "url": d.get("htmlLink"), "id": d.get("id")}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def list_events(days: int = 7, max_results: int = 10) -> dict:
    """直近 days 日の予定を返す。{ok, items:[{title,start,url}]}。"""
    tok = _access_token()
    if not tok:
        return _err_not_connected()
    from datetime import datetime, timedelta
    now = datetime.now(_jst())
    params = {
        "timeMin": now.isoformat(),
        "timeMax": (now + timedelta(days=int(days or 7))).isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": str(max(1, min(int(max_results or 10), 25))),
    }
    headers = {"Authorization": f"Bearer {tok}"}
    try:
        r = requests.get("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                         headers=headers, params=params, timeout=30)
        d = r.json() if r.content else {}
        items = []
        for ev in d.get("items", []):
            start = ev.get("start", {})
            items.append({
                "title": ev.get("summary", "(無題)"),
                "start": start.get("dateTime") or start.get("date") or "",
                "url": ev.get("htmlLink", ""),
            })
        return {"ok": True, "items": items}
    except Exception as e:
        return {"ok": False, "error": str(e)}
