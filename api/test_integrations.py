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
    import keychain
    monkeypatch.setattr(gservice, "_client_id", lambda: "cid")
    monkeypatch.setattr(gservice, "_client_secret", lambda: "sec")

    class FakeResp:
        content = b"{}"
        def json(self):
            return {"refresh_token": "rt-xyz"}

    monkeypatch.setattr(gservice.requests, "post", lambda *a, **k: FakeResp())
    res = gservice.exchange_code("code123", "https://x/callback")
    assert res["ok"] is True
    assert keychain.get_key("GOOGLE_REFRESH_TOKEN") == "rt-xyz"
    keychain.delete_key("GOOGLE_REFRESH_TOKEN")  # cleanup


def test_gservice_create_sheet_mocked(monkeypatch):
    monkeypatch.setattr(gservice, "_access_token", lambda: "tok")

    class FakeResp:
        content = b"{}"
        def __init__(self, d):
            self._d = d
        def json(self):
            return self._d

    monkeypatch.setattr(gservice.requests, "post",
                        lambda *a, **k: FakeResp({"spreadsheetId": "sid1", "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/sid1"}))
    monkeypatch.setattr(gservice.requests, "put", lambda *a, **k: FakeResp({}))
    res = gservice.create_sheet("表", [["a", "b"], ["1", "2"]])
    assert res["ok"] is True and "sid1" in res["url"]


# ── Google: エンドポイント ───────────────────────────────────────────
def test_google_status_endpoint():
    r = client.get("/google/status")
    assert r.status_code == 200 and "configured" in r.json()


def test_google_auth_start_without_config():
    r = client.get("/google/auth/start")
    assert r.status_code == 400 and "Google未設定" in r.text


def test_google_auth_start_redirects_when_configured(monkeypatch):
    import keychain
    monkeypatch.setattr(keychain, "get_key",
                        lambda name: {"GOOGLE_CLIENT_ID": "cid", "GOOGLE_CLIENT_SECRET": "sec"}.get(name, ""))
    r = client.get("/google/auth/start", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert "accounts.google.com" in r.headers["location"]


def test_google_callback_error_shows_message():
    r = client.get("/google/auth/callback", params={"error": "access_denied"})
    assert r.status_code == 200 and "access_denied" in r.text


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
            executed["sql"] = sql

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
    assert res["ok"] is True and "CREATE TABLE" in executed["sql"]


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
