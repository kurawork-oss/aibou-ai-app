# key_manager.py — 用途別 APIキー（マルチアカウント）レジストリ ＆ 解決ロジック
# =================================================================
# 「各処理(=用途)ごとに、別アカウントで発行したAPIキーを割り当てたい」を実現する
# “保管場所と接続”の中枢。ここが用途(PURPOSES)の唯一の定義元なので、後から用途を
# 増やすときはこのリストに1行足すだけでよい（後から修正しやすい枠組み）。
#
# 保管場所:
#   - アプリ内 : 暗号化Vault の vault["key_slots"] = { purpose_id: {provider, key} }
#               （Settings → Secure Vault の「用途別APIキー」フォームで編集）
#   - headless : 環境変数 GEMINI_API_KEY_<PURPOSE>（例 GEMINI_API_KEY_NIGHTLY）
#
# 接続(解決順): 用途専用キー → 共通キー → 環境変数。未設定なら共通キーにフォールバック。
#
# ※ 各アカウント/キーは各プロバイダの利用規約の範囲内で使うこと（自動ローテーション等の
#   上限回避ロジックは実装しない。用途への割り当てはユーザーが手動で行う）。
# =================================================================

import os

# プロバイダ → 環境変数のベース名 / Vault(api_keys)上のキー名
PROVIDER_ENV = {
    "gemini": "GEMINI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "grok": "GROK_API_KEY",
    "openai": "OPENAI_API_KEY",
}
PROVIDERS = list(PROVIDER_ENV.keys())

# 用途(=各場所)の定義。id はコード側の識別子、label はUI表示、provider は既定プロバイダ。
PURPOSES = [
    {"id": "hub_chat",    "label": "HUB AIコンソール / エージェント", "provider": "gemini"},
    {"id": "income_gen",  "label": "副業 生成エンジン (Auto Income)",  "provider": "gemini"},
    {"id": "nightly",     "label": "夜間生成 cron (GitHub Actions)",   "provider": "gemini"},
    {"id": "asset_image", "label": "画像生成 (アセット)",              "provider": "gemini"},
    {"id": "forge_lab",   "label": "Forge Lab",                        "provider": "gemini"},
]

_BY_ID = {p["id"]: p for p in PURPOSES}


def purpose_ids():
    return [p["id"] for p in PURPOSES]


def purpose_label(purpose):
    return (_BY_ID.get(purpose) or {}).get("label", purpose)


def purpose_provider(purpose):
    return (_BY_ID.get(purpose) or {}).get("provider", "gemini")


def env_var(purpose, provider=None):
    """その用途の環境変数名（例: nightly + gemini → GEMINI_API_KEY_NIGHTLY）。"""
    prov = provider or purpose_provider(purpose)
    base = PROVIDER_ENV.get(prov, "GEMINI_API_KEY")
    return f"{base}_{str(purpose).upper()}"


def resolve_from_slots(slots, purpose):
    """アプリ内Vaultの key_slots から (provider, key) を解決する。未設定は (None, '')。"""
    s = (slots or {}).get(purpose) or {}
    key = (s.get("key") or "").strip()
    if not key:
        return None, ""
    return (s.get("provider") or purpose_provider(purpose)), key


def env_key(purpose, provider=None):
    """headless(環境変数)用: 用途専用キー → 共通キー の順で取得する。"""
    prov = provider or purpose_provider(purpose)
    base = PROVIDER_ENV.get(prov, "GEMINI_API_KEY")
    return os.environ.get(env_var(purpose, prov)) or os.environ.get(base) or ""
