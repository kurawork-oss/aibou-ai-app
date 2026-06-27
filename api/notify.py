"""
api/notify.py — 外部通知（LINE Notify / Discord / Slack）。

Keychain に保存されたトークンを使い、ジョブやオートパイロットの結果をスマホへ届ける。
標準ライブラリ(urllib)のみ。トークン未設定なら何もせず {"ok": False, "skipped": True}
を返す（ネットワークアクセスもしない）。失敗しても絶対に crash しない。
"""

import json
import urllib.request
from typing import Dict, List

import keychain

_TIMEOUT = 8  # 秒


def _post_form(url: str, data: Dict[str, str], headers: Dict[str, str]) -> bool:
    encoded = "&".join(f"{_q(k)}={_q(v)}" for k, v in data.items()).encode("utf-8")
    req = urllib.request.Request(url, data=encoded, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return 200 <= resp.status < 300


def _q(s: str) -> str:
    from urllib.parse import quote_plus
    return quote_plus(str(s))


def _post_json(url: str, payload: dict) -> bool:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return 200 <= resp.status < 300


def send_line(message: str) -> dict:
    """LINE Notify でメッセージを送る。トークン未設定なら skipped。"""
    token = keychain.get_key("LINE_NOTIFY_TOKEN")
    if not token:
        return {"ok": False, "skipped": True, "channel": "line"}
    try:
        ok = _post_form(
            "https://notify-api.line.me/api/notify",
            {"message": message},
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        return {"ok": ok, "channel": "line"}
    except Exception as e:
        return {"ok": False, "error": str(e), "channel": "line"}


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


def notify_all(message: str) -> dict:
    """設定済みの全チャンネルへ送る。少なくとも1つ成功すれば ok=True。"""
    results: List[dict] = [send_line(message), send_discord(message), send_slack(message)]
    sent = [r for r in results if r.get("ok")]
    skipped = all(r.get("skipped") for r in results)
    return {
        "ok": len(sent) > 0,
        "sent": [r["channel"] for r in sent],
        "skipped": skipped,
        "results": results,
    }
