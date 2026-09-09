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

import json
import os
import uuid

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
    """アプリ登録が済んでいるか。

    client_id / secret は「このアプリ自身の身分証」なので、持ち主が1回だけ
    サーバーに置けば、利用者は誰も入力しなくてよい。
    """
    import oauth
    return oauth.configured("google")


def connected() -> bool:
    import oauth
    return oauth.connected("google")


def status() -> dict:
    """UI用の状態。繋いでいるアカウントも返す。

    「作ったと言われたのにドライブに無い」の原因が、見に行ったのと違う
    アカウントに繋いでいた、ということがある。どこに作られるのかを
    先に見せておけば、その取り違えに気づける。
    """
    out = {"configured": configured(), "connected": connected()}
    if out["connected"]:
        out["account"] = account_email()
    return out


def auth_url(redirect: str, user_id: str = "") -> str:
    """同意画面のURL（共通の仕組みに委譲）。"""
    import oauth
    return (oauth.start_url("google", redirect, user_id) or {}).get("url", "")


def exchange_code(code: str, redirect: str) -> dict:
    """認可コードをトークンに替えて保存する（共通の仕組みに委譲）。"""
    import oauth
    return oauth.finish("google", code, redirect)


def disconnect() -> dict:
    import oauth
    return oauth.disconnect("google")


def _access_token():
    """使えるアクセストークン。失敗時 None。

    取り回しは oauth に寄せてある。以前はここで毎回 refresh を叩いていたが、
    Googleを使う操作のたびに余分な往復が1回増えていた。共通側は期限内なら
    そのまま使い回す。
    """
    import oauth
    return oauth.access_token("google") or None


def _err_not_connected() -> dict:
    if not configured():
        return {"ok": False, "error": "Google未設定です（KEYCHAINでGOOGLE_CLIENT_ID/SECRETを設定）"}
    return {"ok": False,
            "error": "Google未接続です。拡張機能から「Googleと連携する」を押すと繋がります。"}


# ── 作ったと言う前に、本当にあるか確かめる ───────────────────────────
# 報告: 「Googleドライブにファイルを作った」と言われたのに、ドライブに無かった。
#
# API が 200 を返しても、それだけでは足りない。本文の書き込みが別リクエストで、
# そちらが失敗しても成功として返っていた（中身が空のまま「作成しました」）。
# 繋いでいるアカウントが、見に行ったドライブと違うこともある。
#
# 作った直後にドライブへ問い合わせて、実在と持ち主を確かめる。
# 1往復増えるが、「作ったと言われた物が無い」より軽い。
def _verify_in_drive(tok: str, file_id: str) -> dict:
    if not (tok and file_id):
        return {"ok": False, "error": "確認できませんでした"}
    try:
        r = requests.get(
            f"https://www.googleapis.com/drive/v3/files/{file_id}",
            headers={"Authorization": f"Bearer {tok}"},
            params={"fields": "id,name,webViewLink,trashed,owners(emailAddress)"},
            timeout=20)
        if r.status_code != 200:
            d = r.json() if r.content else {}
            return {"ok": False,
                    "error": (d.get("error") or {}).get("message") or f"HTTP {r.status_code}"}
        d = r.json() or {}
        if d.get("trashed"):
            return {"ok": False, "error": "作成されましたが、ゴミ箱に入っています"}
        owners = d.get("owners") or []
        return {"ok": True,
                "name": d.get("name") or "",
                "link": d.get("webViewLink") or "",
                "account": (owners[0].get("emailAddress") if owners else "") or ""}
    except Exception as e:
        return {"ok": False, "error": str(e)[:160]}


def _check_write(resp) -> str:
    """本文の書き込みが通ったか。失敗の理由を返す（成功なら空文字）。

    ここを見ずに握りつぶしていたので、中身が空のまま「作成しました」になっていた。
    """
    try:
        if resp is None:
            return "本文を書き込めませんでした"
        if 200 <= resp.status_code < 300:
            return ""
        d = resp.json() if resp.content else {}
        return ((d.get("error") or {}).get("message")
                or f"本文を書き込めませんでした（HTTP {resp.status_code}）")
    except Exception as e:
        return f"本文を書き込めませんでした（{str(e)[:120]}）"


def account_email() -> str:
    """いま繋いでいるGoogleアカウント。どこに作られたのかを言えるようにする。"""
    tok = _access_token()
    if not tok:
        return ""
    try:
        r = requests.get("https://www.googleapis.com/drive/v3/about",
                         headers={"Authorization": f"Bearer {tok}"},
                         params={"fields": "user(emailAddress)"}, timeout=15)
        if r.status_code != 200:
            return ""
        return ((r.json() or {}).get("user") or {}).get("emailAddress") or ""
    except Exception:
        return ""


def upload_file(name: str, content: str, mime: str = "text/plain") -> dict:
    """Googleドライブにファイルを作る（Googleドキュメント形式ではなく、そのまま）。

    これまで作れたのは Docs / Sheets / Slides だけだった。「ドライブにファイルを
    作って」に当たるツールが無く、AIbouの中に保存するだけの機能が選ばれて
    「作成しました」と返っていた。ここを埋める。
    """
    name = (name or "").strip() or "無題.txt"
    tok = _access_token()
    if not tok:
        return _err_not_connected()
    body = content if isinstance(content, str) else str(content or "")
    boundary = "aibou" + uuid.uuid4().hex
    meta = json.dumps({"name": name}, ensure_ascii=False)
    payload = (
        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n"
        f"--{boundary}\r\nContent-Type: {mime}; charset=UTF-8\r\n\r\n{body}\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    try:
        r = requests.post(
            "https://www.googleapis.com/upload/drive/v3/files",
            headers={"Authorization": f"Bearer {tok}",
                     "Content-Type": f"multipart/related; boundary={boundary}"},
            params={"uploadType": "multipart", "fields": "id,name,webViewLink"},
            data=payload, timeout=45)
        d = r.json() if r.content else {}
        fid = d.get("id")
        if not fid:
            return {"ok": False,
                    "error": (d.get("error") or {}).get("message") or "作成に失敗しました"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:160]}

    seen = _verify_in_drive(tok, fid)
    if not seen.get("ok"):
        return {"ok": False, "error": f"作成の確認が取れませんでした（{seen.get('error')}）"}
    return {"ok": True, "id": fid, "name": seen.get("name") or name,
            "url": seen.get("link") or d.get("webViewLink") or "",
            "account": seen.get("account", "")}


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
        write_err = ""
        if values:
            wr = requests.put(
                f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/A1",
                headers=headers, params={"valueInputOption": "RAW"},
                json={"values": values}, timeout=30)
            write_err = _check_write(wr)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    seen = _verify_in_drive(tok, sid)
    if not seen.get("ok"):
        return {"ok": False, "error": f"作成の確認が取れませんでした（{seen.get('error')}）"}
    out = {"ok": True, "url": seen.get("link") or url, "id": sid,
           "account": seen.get("account", "")}
    if write_err:
        out["warning"] = f"表は作られましたが、中身が入っていません（{write_err}）"
    return out


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
        write_err = ""
        if content:
            wr = requests.post(
                f"https://docs.googleapis.com/v1/documents/{did}:batchUpdate",
                headers=headers,
                json={"requests": [{"insertText": {"location": {"index": 1}, "text": content}}]},
                timeout=30)
            write_err = _check_write(wr)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    seen = _verify_in_drive(tok, did)
    if not seen.get("ok"):
        return {"ok": False, "error": f"作成の確認が取れませんでした（{seen.get('error')}）"}
    out = {"ok": True, "id": did, "account": seen.get("account", ""),
           "url": seen.get("link") or f"https://docs.google.com/document/d/{did}/edit"}
    if write_err:
        out["warning"] = f"ファイルは作られましたが、本文が入っていません（{write_err}）"
    return out


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

        write_err = ""
        if reqs:
            wr = requests.post(f"https://slides.googleapis.com/v1/presentations/{pid}:batchUpdate",
                               headers=headers, json={"requests": reqs}, timeout=45)
            write_err = _check_write(wr)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    seen = _verify_in_drive(tok, pid)
    if not seen.get("ok"):
        return {"ok": False, "error": f"作成の確認が取れませんでした（{seen.get('error')}）"}
    out = {"ok": True, "id": pid, "account": seen.get("account", ""),
           "url": seen.get("link") or f"https://docs.google.com/presentation/d/{pid}/edit"}
    if write_err:
        out["warning"] = f"ファイルは作られましたが、中身が入っていません（{write_err}）"
    return out


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
