# email_svc.py — メール送受信（SMTP 送信 / IMAP 受信）
# =====================================================================
# 標準ライブラリ（smtplib / imaplib / email）だけで実装。追加依存なし。
# 認証情報は KEYCHAIN:
#   EMAIL_ADDRESS   … 送受信するメールアドレス
#   EMAIL_PASSWORD  … アプリパスワード（Gmailは2段階認証→アプリパスワード）
#   EMAIL_SMTP_HOST … 既定 smtp.gmail.com
#   EMAIL_IMAP_HOST … 既定 imap.gmail.com
# 設定が欠けても crash せず、分かりやすい文字列/構造で縮退する。
# =====================================================================

import imaplib
import smtplib
import ssl
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parseaddr

import keychain

# Gmail を Google連携で読むときに使う。SMTP/IMAP だけの構成でも
# import で落ちないように、無ければ None にしておく。
try:
    import requests
except Exception:  # pragma: no cover
    requests = None


def _addr() -> str:
    return (keychain.get_key("EMAIL_ADDRESS") or "").strip()


def _password() -> str:
    return (keychain.get_key("EMAIL_PASSWORD") or "").strip()


def _smtp_host() -> str:
    return (keychain.get_key("EMAIL_SMTP_HOST") or "smtp.gmail.com").strip()


def _imap_host() -> str:
    return (keychain.get_key("EMAIL_IMAP_HOST") or "imap.gmail.com").strip()


def _smtp_port() -> int:
    try:
        return int((keychain.get_key("EMAIL_SMTP_PORT") or "465").strip())
    except Exception:
        return 465


def _gmail_ready() -> bool:
    """Googleを連携済みなら、メールはそちらで読める。

    アプリパスワードを作る手順（2段階認証→アプリパスワード→16文字を貼る）は、
    設定の中でいちばん脱落する所だった。Googleを「押すだけ」で繋いであるなら、
    その権限で読めるので、この手順そのものが要らなくなる。
    """
    try:
        import oauth
        return oauth.connected("google")
    except Exception:
        return False


def configured() -> bool:
    """メールを扱えるか。Google連携済みなら、アドレスとパスワードは要らない。"""
    return bool(_gmail_ready() or (_addr() and _password()))


def status() -> dict:
    out = {"configured": configured(), "address": _addr()}
    if _gmail_ready():
        out["via"] = "google"
        out["address"] = out["address"] or _gmail_address()
    elif out["configured"]:
        out["via"] = "imap"
    return out


def _gmail_address() -> str:
    try:
        import oauth
        rec = oauth._load("google") or {}
        return rec.get("account") or ""
    except Exception:
        return ""


def _gmail_inbox(limit: int) -> dict:
    """Gmail API で受信トレイを読む。{ok, items} / {ok:False, error}。"""
    import oauth
    tok = oauth.access_token("google")
    if not tok:
        return {"ok": False, "error": "Google連携の期限が切れています。繋ぎ直してください"}
    if requests is None:
        return {"ok": False, "error": "requests が利用できません"}
    head = {"Authorization": f"Bearer {tok}"}
    base = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
    try:
        r = requests.get(base, headers=head,
                         params={"maxResults": limit, "labelIds": "INBOX"}, timeout=30)
        d = r.json() if r.content else {}
    except Exception as e:
        return {"ok": False, "error": f"Gmailに繋がりませんでした（{str(e)[:120]}）"}
    if d.get("error"):
        msg = (d["error"] or {}).get("message", "")
        if "insufficient" in msg.lower() or "scope" in msg.lower():
            return {"ok": False, "error": "メールを読む権限がありません。"
                                          "「連携」からGoogleを繋ぎ直してください"}
        return {"ok": False, "error": f"Gmailが受け付けませんでした（{msg[:120]}）"}

    items = []
    for m in (d.get("messages") or [])[:limit]:
        try:
            rr = requests.get(f"{base}/{m['id']}", headers=head, timeout=30, params={
                "format": "metadata",
                "metadataHeaders": ["From", "Subject", "Date"],
            })
            md = rr.json() if rr.content else {}
        except Exception:
            continue
        headers = {h.get("name", "").lower(): h.get("value", "")
                   for h in ((md.get("payload") or {}).get("headers") or [])}
        items.append({
            "id": md.get("id") or m.get("id") or "",
            "from": parseaddr(headers.get("from", ""))[1] or headers.get("from", ""),
            "subject": headers.get("subject", ""),
            "date": headers.get("date", ""),
            "snippet": (md.get("snippet") or "")[:240],
        })
    return {"ok": True, "items": items}


def send(to: str, subject: str, body: str) -> dict:
    """メールを送信する。{ok, to} / {ok:False, error}。"""
    to = (to or "").strip()
    if not to:
        return {"ok": False, "error": "宛先(to)が空です"}
    if not configured():
        return {"ok": False, "error": "メール未設定（「連携」のメールで EMAIL_ADDRESS / EMAIL_PASSWORD を設定）"}
    msg = EmailMessage()
    msg["From"] = _addr()
    msg["To"] = to
    msg["Subject"] = subject or "(件名なし)"
    msg.set_content(body or "")
    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(_smtp_host(), _smtp_port(), context=ctx, timeout=30) as s:
            s.login(_addr(), _password())
            s.send_message(msg)
        return {"ok": True, "to": to}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _decode(s) -> str:
    try:
        return str(make_header(decode_header(s or "")))
    except Exception:
        return s or ""


def _body_snippet(m, limit: int = 240) -> str:
    """本文の先頭スニペットを取り出す（text/plain 優先）。"""
    try:
        if m.is_multipart():
            for part in m.walk():
                if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition", "")):
                    payload = part.get_payload(decode=True) or b""
                    return payload.decode(part.get_content_charset() or "utf-8", "ignore").strip()[:limit]
            return ""
        payload = m.get_payload(decode=True) or b""
        return payload.decode(m.get_content_charset() or "utf-8", "ignore").strip()[:limit]
    except Exception:
        return ""


def inbox(limit: int = 5) -> dict:
    """受信トレイの最新メールを返す。{ok, items:[{id,from,subject,date,snippet}]}。

    Googleを繋いであればそちらで読む。繋いでいなければ、これまで通り
    アドレスとアプリパスワードでIMAPに繋ぐ。
    """
    limit = max(1, min(int(limit or 5), 20))
    if _gmail_ready():
        return _gmail_inbox(limit)
    if not (_addr() and _password()):
        return {"ok": False,
                "error": "メールが未設定です。「連携」からGoogleを繋ぐと、"
                         "パスワードを入れずに読めるようになります"
                         "（Google以外のメールは EMAIL_ADDRESS と EMAIL_PASSWORD を設定）"}
    try:
        M = imaplib.IMAP4_SSL(_imap_host(), timeout=30)
        M.login(_addr(), _password())
        M.select("INBOX")
        typ, data = M.search(None, "ALL")
        ids = (data[0].split() if data and data[0] else [])
        latest = ids[-limit:][::-1]
        items = []
        for i in latest:
            typ, msg_data = M.fetch(i, "(RFC822)")
            if not msg_data or not msg_data[0]:
                continue
            import email as email_lib
            m = email_lib.message_from_bytes(msg_data[0][1])
            frm = parseaddr(_decode(m.get("From", "")))
            items.append({
                # Message-ID は送信側が付ける、そのメール固有の名札。
                # これが無いと見張りが「同じメールか別のメールか」を判断できず、
                # 件名が同じメールを1通と数えたり、毎回新着と数えたりする。
                "id": (m.get("Message-ID") or "").strip(),
                "from": frm[1] or _decode(m.get("From", "")),
                "subject": _decode(m.get("Subject", "")),
                "date": m.get("Date", ""),
                "snippet": _body_snippet(m),
            })
        try:
            M.logout()
        except Exception:
            pass
        return {"ok": True, "items": items}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}
