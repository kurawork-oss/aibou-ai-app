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


def configured() -> bool:
    return bool(_addr() and _password())


def status() -> dict:
    return {"configured": configured(), "address": _addr()}


def send(to: str, subject: str, body: str) -> dict:
    """メールを送信する。{ok, to} / {ok:False, error}。"""
    to = (to or "").strip()
    if not to:
        return {"ok": False, "error": "宛先(to)が空です"}
    if not configured():
        return {"ok": False, "error": "メール未設定（KEYCHAINでEMAIL_ADDRESS/EMAIL_PASSWORDを設定）"}
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
    """受信トレイの最新メールを返す。{ok, items:[{from,subject,date,snippet}]}。"""
    if not configured():
        return {"ok": False, "error": "メール未設定（KEYCHAINでEMAIL_ADDRESS/EMAIL_PASSWORDを設定）"}
    limit = max(1, min(int(limit or 5), 20))
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
