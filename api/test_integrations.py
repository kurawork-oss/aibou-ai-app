# test_integrations.py — Google連携 + DB自動マイグレーションのテスト
# 外部（Google / Postgres）へは出ず、monkeypatch でモックする。

import sys
import types

from fastapi.testclient import TestClient

import gservice
import migrate
import tools
from main import app

client = TestClient(app)


# ── Google: ツールの縮退（未設定/未接続で crash しない） ──────────────
def test_google_sheet_tool_requires_rows():
    assert "空" in tools.execute_tool("google_sheet", {"title": "x", "rows": []})


def test_google_doc_tool_requires_content():
    assert "空" in tools.execute_tool("google_doc", {"title": "x", "content": ""})


def test_google_tools_not_configured_message():
    r = tools.execute_tool("google_sheet", {"title": "x", "rows": [["a"]]})
    assert "Google" in r and ("未設定" in r or "未接続" in r)


def test_google_sheet_tool_success(monkeypatch):
    monkeypatch.setattr(gservice, "create_sheet",
                        lambda title, rows: {"ok": True, "url": "https://docs.google.com/spreadsheets/d/x", "id": "x"})
    r = tools.execute_tool("google_sheet", {"title": "月次", "rows": [["a"]]})
    assert "docs.google.com" in r


# ── Google: OAuth ロジック ───────────────────────────────────────────
def test_gservice_status_default():
    st = gservice.status()
    assert set(st) == {"configured", "connected"}


def test_gservice_exchange_code_stores_refresh(monkeypatch):
    """認可コードを交換して、更新用トークンが残ること。

    保存の形は共通の仕組み（oauth）に移した。以前は GOOGLE_REFRESH_TOKEN
    という1つの鍵だったが、提供元ごとに期限や口座名も持つ必要があるので
    OAUTH_GOOGLE にまとめてある。
    """
    import oauth
    monkeypatch.setattr(oauth, "_app_credentials", lambda p: ("cid", "sec"))
    monkeypatch.setattr(oauth, "_whoami", lambda p, t: "me@example.com")

    class FakeResp:
        content = b"{}"
        def json(self):
            return {"refresh_token": "rt-xyz", "access_token": "at-1", "expires_in": 3600}

    monkeypatch.setattr(oauth.requests, "post", lambda *a, **k: FakeResp())
    res = gservice.exchange_code("code123", "https://x/callback")
    assert res["ok"] is True and res["account"] == "me@example.com"
    assert oauth.connected("google") is True
    assert oauth._load("google")["refresh_token"] == "rt-xyz"
    oauth.disconnect("google")  # cleanup


def test_an_old_google_connection_still_works(monkeypatch):
    """以前の形（GOOGLE_REFRESH_TOKEN だけ）で繋いである人が、
    繋ぎ直さずにそのまま使えること。"""
    import keychain, oauth
    keychain.set_key("GOOGLE_REFRESH_TOKEN", "rt-old")
    try:
        assert oauth.connected("google") is True
        assert oauth._load("google")["refresh_token"] == "rt-old"
        assert gservice.connected() is True
    finally:
        keychain.delete_key("GOOGLE_REFRESH_TOKEN")


def test_gservice_create_sheet_mocked(monkeypatch):
    monkeypatch.setattr(gservice, "_access_token", lambda: "tok")

    class FakeResp:
        content = b"{}"
        def __init__(self, d, status=200):
            self._d, self.status_code = d, status
        def json(self):
            return self._d

    monkeypatch.setattr(gservice.requests, "post",
                        lambda *a, **k: FakeResp({"spreadsheetId": "sid1", "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/sid1"}))
    monkeypatch.setattr(gservice.requests, "put", lambda *a, **k: FakeResp({}))
    # 作成後にドライブへ実在を確かめに行くようになった（作りっぱなしにしない）
    monkeypatch.setattr(gservice.requests, "get", lambda *a, **k: FakeResp(
        {"id": "sid1", "name": "表", "trashed": False,
         "webViewLink": "https://docs.google.com/spreadsheets/d/sid1",
         "owners": [{"emailAddress": "me@example.com"}]}))
    res = gservice.create_sheet("表", [["a", "b"], ["1", "2"]])
    assert res["ok"] is True and "sid1" in res["url"]
    assert res.get("warning") is None, "中身は書けているのに警告が出ている"
    assert res.get("account") == "me@example.com"


# ── Google: エンドポイント ───────────────────────────────────────────
def test_google_status_endpoint():
    r = client.get("/google/status")
    assert r.status_code == 200 and "configured" in r.json()


def test_google_auth_start_without_config():
    """アプリ登録が済んでいなければ、始められないと伝えること（200で成功に見せない）。"""
    r = client.get("/google/auth/start")
    assert r.status_code == 400
    assert "GOOGLE_CLIENT_ID" in r.text and "持ち主が1回だけ" in r.text


def test_google_auth_start_redirects_when_configured(monkeypatch):
    import keychain
    monkeypatch.setattr(keychain, "get_key",
                        lambda name: {"GOOGLE_CLIENT_ID": "cid", "GOOGLE_CLIENT_SECRET": "sec"}.get(name, ""))
    r = client.get("/google/auth/start", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert "accounts.google.com" in r.headers["location"]


def test_google_callback_error_shows_message():
    """許可されなかったとき、理由を出し、成功に見せないこと。"""
    r = client.get("/google/auth/callback", params={"error": "access_denied"})
    assert r.status_code == 400 and "access_denied" in r.text


# ── DB 自動マイグレーション ──────────────────────────────────────────
def test_run_migrations_skipped_without_url(monkeypatch):
    monkeypatch.setattr(migrate, "db_url", lambda: "")
    assert migrate.run_migrations().get("skipped") is True


def test_run_migrations_with_mocked_db(monkeypatch):
    monkeypatch.setattr(migrate, "db_url", lambda: "postgresql://fake")
    monkeypatch.setattr(migrate, "_read_schema", lambda: "CREATE TABLE IF NOT EXISTS x(id int);")
    executed = {}

    class FakeCur:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def execute(self, sql):
            # 1本ずつ流すようになったので、全部を覚えておく。
            # 最後の1本だけ見ていると、追加のSQL（pgvector等）が末尾に来た
            # 時点で「スキーマが流れていない」と誤判定する。
            executed.setdefault("sql", []).append(sql)

    class FakeConn:
        autocommit = False
        def cursor(self):
            return FakeCur()
        def close(self):
            executed["closed"] = True

    fake = types.ModuleType("psycopg2")
    fake.connect = lambda url, connect_timeout=15: FakeConn()
    monkeypatch.setitem(sys.modules, "psycopg2", fake)

    res = migrate.run_migrations()
    assert res["ok"] is True
    assert any("CREATE TABLE" in q for q in executed["sql"]), "本体のスキーマが流れていない"
    # 追加のSQL（supabase/migrations/）も流れること
    assert any("match_memories" in q for q in executed["sql"]), \
        "pgvector の追加SQLが流れていない（意味検索の土台が作られない）"
    assert executed.get("closed") is True


def test_table_status_no_config(monkeypatch):
    import config
    monkeypatch.setattr(migrate, "db_url", lambda: "")
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    st = migrate.table_status()
    assert st["connected"] is False and "artifacts" in st["missing"]


def test_admin_db_status_endpoint():
    r = client.get("/admin/db/status")
    assert r.status_code == 200 and "missing" in r.json()


def test_admin_migrate_endpoint_skipped(monkeypatch):
    monkeypatch.setattr(migrate, "db_url", lambda: "")
    r = client.post("/admin/migrate")
    assert r.status_code == 200 and r.json().get("skipped") is True
