# newsletter.py — ⑤ マイクロSaaS / ニュースレター（顧客リスト＋定期配信）
# =====================================================================
# 企画書フェーズ2の「集めたトラフィック → アドレス取得 → 定期課金へ誘導」を担う。
#
#   * SEOページ(/g/{slug})の登録フォームから subscribe()
#   * ダブルオプトイン：確認メールのリンクを踏むまで pending（配信されない）
#   * 全配信メールに配信停止リンクを付ける（特定電子メール法の要件）
#   * 配信は下書き→承認→送信のセミオート（暴走防止）
#
# メール送信は既存の email_svc（SMTP）を使う。未設定でも crash しない。
# =====================================================================

import hashlib
import re
import secrets
from datetime import datetime, timezone
from typing import List, Optional

import config
import memstore

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")

_mem_subs = memstore.TenantList()   # Supabase未設定時のフォールバック
_mem_issues = memstore.TenantList()
STATUSES = ("pending", "confirmed", "unsubscribed")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def valid_email(email: str) -> bool:
    e = (email or "").strip()
    return bool(_EMAIL_RE.match(e)) and len(e) <= 254


def _token(email: str) -> str:
    """購読者ごとの確認/解除トークン（推測されにくく、再現可能）。"""
    salt = ""
    try:
        salt = config.KEYCHAIN_SECRET or ""
    except Exception:
        salt = ""
    if not salt:
        salt = "forge-newsletter"
    return hashlib.sha256(f"{salt}:{email.strip().lower()}".encode()).hexdigest()[:32]


def site_url() -> str:
    import os
    return (os.environ.get("PUBLIC_SITE_URL", "") or "").rstrip("/")


# ── 購読者 ───────────────────────────────────────────────────────────
def subscribe(email: str, source: str = "") -> dict:
    """購読を受け付け、確認メールを送る（ダブルオプトイン）。"""
    email = (email or "").strip().lower()
    if not valid_email(email):
        return {"error": "メールアドレスの形式が正しくありません"}

    existing = get_subscriber(email)
    if existing and existing.get("status") == "confirmed":
        return {"ok": True, "status": "already_confirmed"}

    row = {
        "email": email,
        "status": "pending",
        "source": (source or "")[:120],
        "token": _token(email),
        "created_at": _now_iso(),
    }
    c = config.get_supabase()
    if c:
        try:
            c.table("subscribers").upsert(row).execute()
        except Exception:
            pass
    # 入れ物ごと置き換えると、保存先ごとに分けている意味が消える。
    # その場で削る。
    for _i in range(len(_mem_subs) - 1, -1, -1):
        s = _mem_subs[_i]
        if not (s.get("email") != email):
            del _mem_subs[_i]
    _mem_subs.insert(0, row)

    sent = _send_confirmation(email, row["token"])
    return {"ok": True, "status": "pending", "confirmation_sent": sent}


def _send_confirmation(email: str, token: str) -> bool:
    base = site_url()
    link = f"{base}/newsletter/confirm?token={token}" if base else f"（確認リンク: token={token}）"
    body = (
        "ニュースレターへのご登録ありがとうございます。\n\n"
        "下記のリンクを開くと購読が確定します（開かれるまで配信は行いません）。\n"
        f"{link}\n\n"
        "このメールに心当たりがない場合は、破棄してください。何も起こりません。\n"
    )
    try:
        import email_svc
        res = email_svc.send(email, "【確認】ニュースレターのご登録", body)
        return bool(res.get("ok"))
    except Exception:
        return False


def confirm(token: str) -> dict:
    """確認リンクを踏んだときの処理。"""
    sub = _find_by_token(token)
    if not sub:
        return {"error": "リンクが無効か、期限切れです"}
    return _set_status(sub["email"], "confirmed")


def unsubscribe(token: str) -> dict:
    sub = _find_by_token(token)
    if not sub:
        return {"error": "リンクが無効です"}
    return _set_status(sub["email"], "unsubscribed")


def _find_by_token(token: str) -> Optional[dict]:
    token = (token or "").strip()
    if not token:
        return None
    c = config.get_supabase()
    if c:
        try:
            rows = c.table("subscribers").select("*").eq("token", token).limit(1).execute().data or []
            if rows:
                return rows[0]
        except Exception:
            pass
    for s in _mem_subs:
        if s.get("token") == token:
            return s
    return None


def _set_status(email: str, status: str) -> dict:
    if status not in STATUSES:
        return {"error": f"invalid status: {status}"}
    c = config.get_supabase()
    if c:
        try:
            c.table("subscribers").update({"status": status}).eq("email", email).execute()
        except Exception:
            pass
    for s in _mem_subs:
        if s.get("email") == email:
            s["status"] = status
    return {"ok": True, "email": email, "status": status}


def get_subscriber(email: str) -> Optional[dict]:
    email = (email or "").strip().lower()
    c = config.get_supabase()
    if c:
        try:
            rows = c.table("subscribers").select("*").eq("email", email).limit(1).execute().data or []
            if rows:
                return rows[0]
        except Exception:
            pass
    for s in _mem_subs:
        if s.get("email") == email:
            return s
    return None


def list_subscribers(status: Optional[str] = None, limit: int = 500) -> List[dict]:
    """購読者一覧（メールはそのまま返す。UIでマスクする）。"""
    c = config.get_supabase()
    if c:
        try:
            q = c.table("subscribers").select("*").order("created_at", desc=True).limit(limit)
            if status:
                q = q.eq("status", status)
            return q.execute().data or []
        except Exception:
            pass
    items = [s for s in _mem_subs if not status or s.get("status") == status]
    return items[:limit]


def stats() -> dict:
    subs = list_subscribers(None, 5000)
    out = {s: 0 for s in STATUSES}
    for s in subs:
        st = s.get("status") or "pending"
        out[st] = out.get(st, 0) + 1
    out["total"] = len(subs)
    return out


# ── 配信（下書き→承認→送信） ─────────────────────────────────────────
def draft_issue(subject: str, body: str = "", topic: str = "") -> dict:
    """配信内容の下書きを作る。topic を渡すとAIが本文を書く。"""
    subject = (subject or "").strip()
    body = (body or "").strip()
    if topic and not body:
        try:
            import llm
            body = llm.generate_text(
                f"ニュースレターの本文を書いてください。テーマ「{topic}」。"
                "読者に役立つ具体的な内容を、見出しなしのプレーンテキストで600字程度。"
                "誇張や根拠のない数値は書かない。最後に一文で次回予告。",
                max_tokens=1200,
            )
        except Exception as e:
            return {"error": f"本文の生成に失敗しました: {e}"}
    if not (subject and body):
        return {"error": "件名と本文（またはtopic）が必要です"}

    issue = {
        "id": secrets.token_hex(8),
        "subject": subject[:150],
        "body": body,
        "status": "draft",
        "created_at": _now_iso(),
        "sent_count": 0,
    }
    c = config.get_supabase()
    if c:
        try:
            res = c.table("newsletter_issues").insert(issue).execute()
            if res.data:
                return res.data[0]
        except Exception:
            pass
    _mem_issues.insert(0, issue)
    return issue


def list_issues(limit: int = 50) -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            return c.table("newsletter_issues").select("*").order("created_at", desc=True).limit(limit).execute().data or []
        except Exception:
            pass
    return _mem_issues[:limit]


def get_issue(issue_id: str) -> Optional[dict]:
    for i in list_issues(500):
        if i.get("id") == issue_id:
            return i
    return None


def _footer(token: str) -> str:
    base = site_url()
    link = f"{base}/newsletter/unsubscribe?token={token}" if base else "（配信停止をご希望の場合は本メールに返信してください）"
    return ("\n\n———\n配信停止はこちら：\n" + link +
            "\n（このメールは、ご自身で購読を確認いただいた方にお送りしています）")


def send_issue(issue_id: str, test_to: str = "") -> dict:
    """承認済みの号を confirmed 購読者へ送る。test_to 指定時はそのアドレスにのみ送る。"""
    issue = get_issue(issue_id)
    if not issue:
        return {"error": "号が見つかりません"}

    try:
        import email_svc
        if not email_svc.configured():
            return {"error": "メール送信が未設定です（「連携」のメール: EMAIL_ADDRESS / EMAIL_PASSWORD）"}
    except Exception as e:
        return {"error": f"メール送信を初期化できません: {e}"}

    if test_to:
        if not valid_email(test_to):
            return {"error": "テスト送信先の形式が正しくありません"}
        targets = [{"email": test_to, "token": _token(test_to)}]
    else:
        targets = [s for s in list_subscribers("confirmed", 5000) if valid_email(s.get("email", ""))]
        if not targets:
            return {"error": "確認済みの購読者がいません"}

    sent, failed = 0, []
    import compliance
    for t in targets:
        body = issue["body"] + _footer(t.get("token") or _token(t["email"]))
        try:
            res = email_svc.send(t["email"], issue["subject"], body)
            if res.get("ok"):
                sent += 1
            else:
                failed.append({"email": t["email"], "error": res.get("error", "")})
        except Exception as e:
            failed.append({"email": t["email"], "error": str(e)})
        if len(targets) > 1:
            compliance.polite_delay(1.5, 4)  # 一斉送信を急がない

    if not test_to:
        c = config.get_supabase()
        if c:
            try:
                c.table("newsletter_issues").update({"status": "sent", "sent_count": sent}).eq("id", issue_id).execute()
            except Exception:
                pass
        for i in _mem_issues:
            if i.get("id") == issue_id:
                i["status"] = "sent"
                i["sent_count"] = sent

    return {"ok": sent > 0, "sent": sent, "failed": failed, "test": bool(test_to)}
