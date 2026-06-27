"""
api/keychain.py — APIキー保管庫（認証コード付きの「鍵束」のサーバー側）。

各種APIキー（Gemini / LINE Notify / 画像生成 / YouTube 等）をサーバーに保管する。
Supabase テーブル `api_keys` を使い、未設定ならプロセス内メモリにフォールバックする
（外部サービスが無くても絶対に crash しない）。

セキュリティ方針:
  * フルの値は決して API から返さない（list は必ずマスクして返す）。
  * 値は os.environ にも反映し、同プロセスの config / 各モジュールが拾えるようにする。
  * GEMINI_API_KEY が更新されたら即座に Gemini を再 configure する。
"""

import os
from typing import Dict, List

import config

# UI にプリセット表示する「よく使うキー」。任意の名前も保存できる。
KNOWN_KEYS: List[Dict[str, str]] = [
    {"name": "GEMINI_API_KEY", "label": "Gemini API Key", "hint": "チャット・生成の頭脳（必須）"},
    {"name": "LINE_NOTIFY_TOKEN", "label": "LINE Notify Token", "hint": "自動タスクの通知先"},
    {"name": "DISCORD_WEBHOOK", "label": "Discord Webhook", "hint": "ジョブ結果の通知"},
    {"name": "SLACK_WEBHOOK", "label": "Slack Webhook", "hint": "ジョブ結果の通知"},
    {"name": "OPENAI_API_KEY", "label": "OpenAI API Key", "hint": "代替の生成エンジン（任意）"},
    {"name": "LEONARDO_API_KEY", "label": "Leonardo.ai Key", "hint": "高品質画像生成（任意）"},
    {"name": "YOUTUBE_API_KEY", "label": "YouTube Data API", "hint": "動画自動投稿（任意）"},
    {"name": "NOTE_TOKEN", "label": "note Token", "hint": "記事自動下書き（任意）"},
    {"name": "SHUTTERSTOCK_FTP", "label": "Shutterstock FTP", "hint": "素材自動アップロード（任意）"},
    {"name": "SUPABASE_URL", "label": "Supabase URL", "hint": "永続ストレージ（任意）"},
    {"name": "SUPABASE_SERVICE_KEY", "label": "Supabase Service Key", "hint": "永続ストレージ（任意）"},
]

# プロセス内フォールバック（Supabase 未設定時）
_mem_keys: Dict[str, str] = {}


def _mask(value: str) -> str:
    """値をマスクする（先頭2 + ●… + 末尾2）。空なら空文字。"""
    v = (value or "").strip()
    if not v:
        return ""
    if len(v) <= 4:
        return "•" * len(v)
    return v[:2] + "•" * min(8, max(4, len(v) - 4)) + v[-2:]


def set_key(name: str, value: str) -> dict:
    """キーを保存する。メモリ + os.environ + Supabase（best-effort）に反映する。"""
    name = (name or "").strip()
    value = (value or "").strip()
    if not name:
        return {"error": "name is required"}

    _mem_keys[name] = value
    # 同プロセスの config / 各モジュールが拾えるよう環境変数にも反映
    os.environ[name] = value

    # Gemini キーは即座に再 configure（次のチャット/生成から有効）
    if name == "GEMINI_API_KEY":
        try:
            config.reconfigure_gemini(value)
        except Exception:
            pass

    # Supabase 永続化（テーブルが無くても落ちない）
    c = config.get_supabase()
    if c:
        try:
            c.table("api_keys").upsert({"name": name, "value": value}).execute()
        except Exception:
            pass

    return {"ok": True, "name": name, "masked": _mask(value), "set": bool(value)}


def get_key(name: str) -> str:
    """フルのキー値を返す（サーバー内部利用専用 / API では返さない）。"""
    name = (name or "").strip()
    if not name:
        return ""
    if name in _mem_keys:
        return _mem_keys[name]
    env = os.environ.get(name, "").strip()
    if env:
        return env
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("api_keys").select("value").eq("name", name)
                    .limit(1).execute().data) or []
            if rows:
                v = (rows[0].get("value") or "").strip()
                _mem_keys[name] = v
                return v
        except Exception:
            pass
    return ""


def list_keys() -> List[dict]:
    """既知キー + 保存済みキーを「マスク値 + 設定有無」で返す（フル値は返さない）。"""
    labels = {k["name"]: k for k in KNOWN_KEYS}
    names: List[str] = [k["name"] for k in KNOWN_KEYS]

    # メモリ保存分を追加
    for n in _mem_keys:
        if n not in names:
            names.append(n)

    # Supabase 保存分を追加
    c = config.get_supabase()
    if c:
        try:
            rows = (c.table("api_keys").select("name").limit(1000).execute().data) or []
            for r in rows:
                n = (r.get("name") or "").strip()
                if n and n not in names:
                    names.append(n)
        except Exception:
            pass

    out: List[dict] = []
    for n in names:
        v = get_key(n)
        meta = labels.get(n, {})
        out.append({
            "name": n,
            "label": meta.get("label", n),
            "hint": meta.get("hint", ""),
            "masked": _mask(v),
            "set": bool(v),
        })
    return out


def delete_key(name: str) -> dict:
    """キーを削除する（メモリ + os.environ + Supabase）。"""
    name = (name or "").strip()
    if not name:
        return {"error": "name is required"}
    _mem_keys.pop(name, None)
    try:
        if name in os.environ:
            del os.environ[name]
    except Exception:
        pass
    if name == "GEMINI_API_KEY":
        try:
            config.reconfigure_gemini("")
        except Exception:
            pass
    c = config.get_supabase()
    if c:
        try:
            c.table("api_keys").delete().eq("name", name).execute()
        except Exception:
            pass
    return {"ok": True}
