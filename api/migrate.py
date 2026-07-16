# migrate.py — Supabase の必要テーブルを「自動作成」する（手動SQL不要）
# =====================================================================
# supabase_schema.sql（冪等・IF NOT EXISTS）を Postgres 直結で実行し、
# artifacts / tasks / events などのテーブルを自動で用意する。
#
# 必要なのは接続文字列 SUPABASE_DB_URL（Supabase ダッシュボードの Connect →
# 「postgresql://…」）。KEYCHAIN か環境変数で設定できる。未設定なら何もしない
# （＝従来どおり in-memory 動作）。他モジュール同様、絶対に crash しない。
# =====================================================================

import os

import keychain

# 現行アプリが使うテーブル（存在チェック用）。
EXPECTED_TABLES = [
    "api_keys", "tasks", "events", "notifications", "automations", "missions",
    "studio_ais", "studio_workflows", "vault_notebooks", "income_jobs",
    "agent_memory", "life_entries", "artifacts",
]

_HERE = os.path.dirname(os.path.abspath(__file__))
# ローカル(repo root) / Docker(/app に同梱) 両対応で探す。
_SCHEMA_CANDIDATES = [
    os.path.join(_HERE, "supabase_schema.sql"),
    os.path.join(os.path.dirname(_HERE), "supabase_schema.sql"),
    "/app/supabase_schema.sql",
    "/supabase_schema.sql",
]


def db_url() -> str:
    """Postgres 接続文字列（KEYCHAIN → 環境変数）。"""
    return (keychain.get_key("SUPABASE_DB_URL") or os.environ.get("SUPABASE_DB_URL", "") or "").strip()


def _read_schema() -> str:
    for p in _SCHEMA_CANDIDATES:
        try:
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    return f.read()
        except Exception:
            continue
    return ""


def run_migrations() -> dict:
    """接続文字列があればスキーマを実行してテーブルを作成する。"""
    url = db_url()
    if not url:
        return {"ok": False, "skipped": True, "reason": "SUPABASE_DB_URL が未設定です（KEYCHAINで設定できます）"}
    sql = _read_schema()
    if not sql:
        return {"ok": False, "error": "スキーマファイルが見つかりませんでした"}
    try:
        import psycopg2  # 遅延 import（未インストール環境でも import 時に落とさない）
    except Exception as e:
        return {"ok": False, "error": f"psycopg2 が利用できません: {e}"}
    try:
        conn = psycopg2.connect(url, connect_timeout=15)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(sql)  # psycopg2 は複数ステートメントを一括実行できる
        conn.close()
        return {"ok": True, "ran": True, "tables": len(EXPECTED_TABLES)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


def table_status() -> dict:
    """どのテーブルが存在するかを返す。DB_URL があれば information_schema で確実に、
    無ければ Supabase(PostgREST) 経由でベストエフォート判定する。"""
    url = db_url()
    if url:
        try:
            import psycopg2
            conn = psycopg2.connect(url, connect_timeout=15)
            with conn.cursor() as cur:
                cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
                have = {r[0] for r in cur.fetchall()}
            conn.close()
            present = [t for t in EXPECTED_TABLES if t in have]
            missing = [t for t in EXPECTED_TABLES if t not in have]
            return {"connected": True, "db_url_set": True, "present": present, "missing": missing}
        except Exception as e:
            return {"connected": False, "db_url_set": True, "error": str(e)[:200],
                    "present": [], "missing": list(EXPECTED_TABLES)}

    import config
    c = config.get_supabase()
    if not c:
        return {"connected": False, "db_url_set": False, "present": [], "missing": list(EXPECTED_TABLES)}
    present, missing = [], []
    for t in EXPECTED_TABLES:
        try:
            c.table(t).select("*").limit(1).execute()
            present.append(t)
        except Exception:
            missing.append(t)
    return {"connected": True, "db_url_set": False, "present": present, "missing": missing}
