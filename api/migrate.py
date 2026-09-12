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
from typing import List, Tuple

import keychain

# 現行アプリが使うテーブル（存在チェック用）。
EXPECTED_TABLES = [
    "api_keys", "tasks", "events", "notifications", "automations", "missions",
    "studio_ais", "studio_workflows", "vault_notebooks", "income_jobs",
    "agent_memory", "life_entries", "artifacts", "schedules",
    "hf_models", "hf_images",
    # あとから足した表。ここに入れ忘れると、実際は欠けているのに
    # 「テーブルは揃っています」と表示されてしまう。
    "conversations", "hooks", "user_connections", "agent_rules",
    "watch_state", "inbox_messages", "setup_sessions", "push_subscriptions",
    "approvals",
]

_HERE = os.path.dirname(os.path.abspath(__file__))
# supabase/migrations/ にある追加のSQL（pgvector・RLSなど）。
# ここを流していなかったので、**意味検索の土台が誰のDBにも作られていなかった**
# ——memory_store は match_memories RPC を呼び、embedding 列へ書こうとするのに、
# どちらもDBに存在しない状態。手で Supabase CLI を叩いた人だけ動いていた。
_MIGRATION_DIRS = [
    os.path.join(os.path.dirname(_HERE), "supabase", "migrations"),
    "/app/supabase/migrations",
]
# ローカル(repo root) / Docker(/app に同梱) 両対応で探す。
_SCHEMA_CANDIDATES = [
    os.path.join(_HERE, "supabase_schema.sql"),
    os.path.join(os.path.dirname(_HERE), "supabase_schema.sql"),
    "/app/supabase_schema.sql",
    "/supabase_schema.sql",
]


def db_url() -> str:
    """Postgres 接続文字列（その人が入れたもの → サーバー既定）。

    ここで環境変数へ素直に落とすと事故になる。SUPABASE_DB_URL は
    「サービスの鍵」ではなく「保存先そのもの」なので、自分のDBを繋いでいる人が
    自分の接続文字列を入れていないときにサーバー（＝持ち主）のDBへ落ちると、
      ・持ち主のDBの表の状況を、自分のDBの状況として見てしまう
        （自分のDBが空でも「テーブルは揃っています」と出る）
      ・「テーブルを作る」を押すと、持ち主のDBに対してDDLが走る
    という2つが同時に起きる。自分のDBを繋いでいる人には、
    自分で入れた接続文字列だけを使う。
    """
    import config
    value, where = keychain.resolve_key("SUPABASE_DB_URL")
    if where == "server" and config.storage_is_bound():
        return ""
    return (value or "").strip()


def _read_schema() -> str:
    for p in _SCHEMA_CANDIDATES:
        try:
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    return f.read()
        except Exception:
            continue
    return ""


def migration_scripts() -> List[Tuple[str, str]]:
    """流すSQLを、流す順に返す。`[(名前, 中身), ...]`

    先に本体（supabase_schema.sql）、そのあと supabase/migrations/ を名前順。
    後者は pgvector と RPC を作る——**ここを流していなかったので、
    意味検索の土台が自動セットアップでは一度も作られていなかった。**
    """
    out: List[Tuple[str, str]] = []
    body = _read_schema()
    if body:
        out.append(("supabase_schema.sql", body))
    for d in _MIGRATION_DIRS:
        try:
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                if not name.endswith(".sql"):
                    continue
                with open(os.path.join(d, name), "r", encoding="utf-8") as f:
                    out.append((name, f.read()))
            break        # 見つかった1か所だけ使う（同じ物を2回流さない）
        except Exception:
            continue
    return out


def run_migrations(url: str = "") -> dict:
    """接続文字列があればスキーマを実行してテーブルを作成する。

    url を渡せる形にしてあるのは、呼び出し側が「誰のDBか」を明示できるように
    するため。以前は os.environ を一時的に書き換えて渡していたが、環境変数は
    プロセス全体で共有なので、同じ瞬間に別の人の要求が走ると、その人のDDLが
    こちらのDBに流れうる。引数なら混ざらない。

    **1本ずつ流す。** 前は全部を1回の execute に渡していたので、どこか1文が
    失敗すると（たとえば `create extension vector` の権限が無いDB）**残り全部が
    流れなかった**。いまは1本ずつ試し、落ちた物は名前と理由を返す
    ——黙って「ok」にしない。
    """
    url = (url or db_url()).strip()
    if not url:
        return {"ok": False, "skipped": True, "reason": "SUPABASE_DB_URL が未設定です（KEYCHAINで設定できます）"}
    scripts = migration_scripts()
    if not scripts:
        return {"ok": False, "error": "スキーマファイルが見つかりませんでした"}
    try:
        import psycopg2  # 遅延 import（未インストール環境でも import 時に落とさない）
    except Exception as e:
        return {"ok": False, "error": f"psycopg2 が利用できません: {e}"}

    ran: List[str] = []
    failed: List[dict] = []
    try:
        conn = psycopg2.connect(url, connect_timeout=15)
        conn.autocommit = True
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}
    try:
        for name, sql in scripts:
            try:
                with conn.cursor() as cur:
                    cur.execute(sql)   # psycopg2 は複数ステートメントを一括実行できる
                ran.append(name)
            except Exception as e:
                failed.append({"script": name, "error": str(e)[:200]})
    finally:
        try:
            conn.close()
        except Exception:
            pass

    return {"ok": bool(ran) and not failed, "ran": ran, "failed": failed,
            "tables": len(EXPECTED_TABLES)}


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
