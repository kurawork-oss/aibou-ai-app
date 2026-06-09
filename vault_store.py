# vault_store.py — headless(GitHub Actions等)から暗号化Vaultを読むための薄いリーダー
# =================================================================
# アプリ内 Settings → Secure Vault に保存した鍵（api_keys / key_slots）を、
# Streamlit非依存で復号して読み出す。これにより「設定はアプリで1回入れるだけ」で、
# GitHub Actions 側もそのVaultから鍵を取得できる（単一の置き場所に集約）。
#
# headless実行時に hydrate_env() を呼ぶと、Vaultの値を環境変数へ流し込む
# （既存の env ベースの解決ロジックがそのまま機能する）。既に設定済みの env は
# 上書きしない（GitHub Secrets を明示指定した場合はそちらが優先）。
#
# 必要な環境変数: SUPABASE_URL / SUPABASE_KEY / MASTER_ENCRYPTION_KEY
# どれも無ければ静かに {} を返す（絶対にraiseしない）。
# =================================================================

import os
import json
import base64
import hashlib


def _cipher():
    mk = os.environ.get("MASTER_ENCRYPTION_KEY", "")
    if not mk:
        return None
    try:
        from cryptography.fernet import Fernet
        h = hashlib.sha256(mk.encode("utf-8")).digest()
        return Fernet(base64.urlsafe_b64encode(h))
    except Exception:
        return None


def _client():
    url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_KEY", "")
    if not (url and key):
        return None
    try:
        from supabase import create_client
        return create_client(url, key)
    except Exception:
        return None


def load_vault():
    """暗号化Vault(vault_data id=1)を復号して dict で返す。失敗時は {}。"""
    c, ci = _client(), _cipher()
    if not (c and ci):
        return {}
    try:
        res = c.table("vault_data").select("encrypted_keys").eq("id", 1).execute()
        if res.data and res.data[0].get("encrypted_keys"):
            enc = res.data[0]["encrypted_keys"]
            if not enc:
                return {}
            return json.loads(ci.decrypt(enc.encode("utf-8")).decode("utf-8"))
    except Exception:
        return {}
    return {}


def _mapping_from_vault(vault):
    """Vaultの api_keys / key_slots を、各処理が参照する環境変数名にマップする。"""
    ak = (vault.get("api_keys") or {})
    slots = (vault.get("key_slots") or {})
    mapping = {
        "GEMINI_API_KEY": ak.get("gemini"),
        "OPENAI_API_KEY": ak.get("openai"),
        "ANTHROPIC_API_KEY": ak.get("anthropic"),
        "GROK_API_KEY": ak.get("grok"),
        "DISCORD_WEBHOOK": ak.get("discord_webhook"),
        "YT_CLIENT_ID": ak.get("youtube_client_id"),
        "YT_CLIENT_SECRET": ak.get("youtube_client_secret"),
        "YT_REFRESH_TOKEN": ak.get("youtube_refresh_token"),
        "SS_FTP_HOST": ak.get("shutterstock_ftp_host"),
        "SS_FTP_USER": ak.get("shutterstock_ftp_user"),
        "SS_FTP_PASS": ak.get("shutterstock_ftp_pass"),
    }
    # 用途別キー（key_slots）→ GEMINI_API_KEY_<用途> 等
    try:
        import key_manager
        for pid, slot in slots.items():
            k = (slot or {}).get("key")
            prov = (slot or {}).get("provider", "gemini")
            if k:
                mapping[key_manager.env_var(pid, prov)] = k
    except Exception:
        pass
    return mapping


def hydrate_env(overwrite=False):
    """Vaultの鍵を環境変数へ流し込む。既存env(=明示指定のSecrets)は既定で尊重する。
    returns: 流し込んだ env 名のリスト。"""
    vault = load_vault()
    if not vault:
        return []
    applied = []
    for name, val in _mapping_from_vault(vault).items():
        if val and (overwrite or not os.environ.get(name)):
            os.environ[name] = val
            applied.append(name)
    return applied
