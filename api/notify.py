"""
api/notify.py — 外部通知（Web Push / LINE / Discord / Slack）。

Keychain に保存されたトークンを使い、ジョブやオートパイロットの結果をスマホへ届ける。
標準ライブラリ(urllib)のみ。トークン未設定なら何もせず {"ok": False, "skipped": True}
を返す（ネットワークアクセスもしない）。失敗しても絶対に crash しない。
"""

import json
import urllib.request
import uuid
from typing import Dict, List

import config
import memstore
import keychain

_TIMEOUT = 8  # 秒

# 内部通知ログ（ホーム画面の「通知」に表示）。Supabase `notifications`、無ければメモリ。
_mem_notes = memstore.TenantList()
def log_internal(message: str, channel: str = "system") -> dict:
    """アプリ内通知を1件記録する（送信の成否に関わらず履歴として残す）。"""
    note = {
        "id": str(uuid.uuid4()),
        "message": (message or "").strip(),
        "channel": channel,
        "read": False,
    }
    _mem_notes.append(note)
    c = config.get_supabase()
    if c:
        try:
            c.table("notifications").insert(note).execute()
        except Exception:
            pass
    return note


def list_internal(limit: int = 50) -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("notifications").select("*")
                    .order("created_at", desc=True).limit(limit).execute().data)
            if rows is not None:
                return rows
        except Exception:
            pass
    return list(reversed(_mem_notes))[:limit]


def mark_all_read() -> dict:
    for n in _mem_notes:
        n["read"] = True
    c = config.get_supabase()
    if c:
        try:
            c.table("notifications").update({"read": True}).eq("read", False).execute()
        except Exception:
            pass
    return {"ok": True}


def unread_count() -> int:
    return sum(1 for n in list_internal(200) if not n.get("read"))


def _post_form(url: str, data: Dict[str, str], headers: Dict[str, str]) -> bool:
    encoded = "&".join(f"{_q(k)}={_q(v)}" for k, v in data.items()).encode("utf-8")
    req = urllib.request.Request(url, data=encoded, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return 200 <= resp.status < 300


def _q(s: str) -> str:
    from urllib.parse import quote_plus
    return quote_plus(str(s))


def _post_json(url: str, payload: dict, headers: Dict[str, str] | None = None) -> bool:
    data = json.dumps(payload).encode("utf-8")
    head = {"Content-Type": "application/json"}
    head.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=head, method="POST")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return 200 <= resp.status < 300


def send_line(message: str) -> dict:
    """LINEへ送る。

    LINE Notify は 2025年3月31日でサービス終了しており、旧トークンでは
    もう届かない。いまの正規の方法は Messaging API なので、そちらを優先する。

      LINE_CHANNEL_TOKEN … チャネルアクセストークン（必須）
      LINE_TO_USER_ID    … 宛先。空ならブロードキャスト（友だち全員）。
                           1人で使うぶんにはブロードキャストで足りる。

    旧 LINE_NOTIFY_TOKEN しか無い人には、黙って失敗せず理由を返す。
    """
    channel_token = keychain.get_key("LINE_CHANNEL_TOKEN")
    if channel_token:
        to = keychain.get_key("LINE_TO_USER_ID")
        url = ("https://api.line.me/v2/bot/message/push" if to
               else "https://api.line.me/v2/bot/message/broadcast")
        payload: dict = {"messages": [{"type": "text", "text": (message or "")[:4900]}]}
        if to:
            payload["to"] = to
        try:
            ok = _post_json(url, payload, {"Authorization": f"Bearer {channel_token}"})
            return {"ok": ok, "channel": "line"}
        except Exception as e:
            return {"ok": False, "error": str(e), "channel": "line"}

    if keychain.get_key("LINE_NOTIFY_TOKEN"):
        # 送信を試みても必ず失敗する。原因が分かる形で返す。
        return {"ok": False, "channel": "line",
                "error": "LINE Notify は2025年3月末で終了しました。"
                         "LINE公式アカウントを作り、LINE_CHANNEL_TOKEN "
                         "（チャネルアクセストークン）を設定してください"}

    return {"ok": False, "skipped": True, "channel": "line"}


def send_discord(message: str) -> dict:
    """Discord Webhook に投稿。未設定なら skipped。"""
    url = keychain.get_key("DISCORD_WEBHOOK")
    if not url:
        return {"ok": False, "skipped": True, "channel": "discord"}
    try:
        return {"ok": _post_json(url, {"content": message}), "channel": "discord"}
    except Exception as e:
        return {"ok": False, "error": str(e), "channel": "discord"}


def send_slack(message: str) -> dict:
    """Slack Incoming Webhook に投稿。未設定なら skipped。"""
    url = keychain.get_key("SLACK_WEBHOOK")
    if not url:
        return {"ok": False, "skipped": True, "channel": "slack"}
    try:
        return {"ok": _post_json(url, {"text": message}), "channel": "slack"}
    except Exception as e:
        return {"ok": False, "error": str(e), "channel": "slack"}


def send_push(message: str) -> dict:
    """この端末へ直接届ける（Web Push）。

    他の3つと違い、**相手方への登録が要らない**。鍵はこのサーバーが
    自分で作るので、通知を許可した時点から届く。何も設定していない人に
    とって、これが唯一届く道になる。
    """
    try:
        import webpush
        title, _, rest = (message or "").partition("\n")
        res = webpush.send(title or "AIbou", rest.strip() or "", url="/")
        if res.get("skipped"):
            return {"ok": False, "skipped": True, "channel": "push"}
        return {"ok": bool(res.get("ok")), "channel": "push", "detail": res}
    except Exception as e:
        return {"ok": False, "channel": "push", "error": str(e)[:160]}


def notify_all(message: str) -> dict:
    """設定済みの全チャンネルへ送る。少なくとも1つ成功すれば ok=True。
    送信の成否に関わらず、アプリ内通知ログにも記録する。"""
    results: List[dict] = [send_push(message), send_line(message),
                           send_discord(message), send_slack(message)]
    sent = [r for r in results if r.get("ok")]
    skipped = all(r.get("skipped") for r in results)
    # 内部ログに残す（ホーム画面の通知に出る）
    try:
        log_internal(message, channel=("+".join(r["channel"] for r in sent) or "system"))
    except Exception:
        pass
    return {
        "ok": len(sent) > 0,
        "sent": [r["channel"] for r in sent],
        "skipped": skipped,
        "results": results,
    }
