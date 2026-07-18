# test_artifacts.py — 成果物ストア（ドキュメント/スプレッドシート）＋ツールのテスト

from fastapi.testclient import TestClient

import artifacts
import tools
from main import app

client = TestClient(app)


# ── ストア本体（Supabase 無し → in-memory フォールバック） ──────────
def test_artifact_create_list_get_delete():
    art = artifacts.create("document", "テスト文書", "# 見出し\n本文", "text/markdown")
    aid = art["id"]
    assert art["title"] == "テスト文書"

    # 一覧はメタデータのみ（content を含まない）
    items = artifacts.list_artifacts()
    meta = next(i for i in items if i["id"] == aid)
    assert "content" not in meta and meta["size"] > 0 and meta["kind"] == "document"

    # get は完全な内容を返す
    full = artifacts.get(aid)
    assert full and full["content"].startswith("# 見出し")

    artifacts.delete(aid)
    assert artifacts.get(aid) is None


def test_artifact_content_is_capped():
    big = "x" * (artifacts.MAX_CONTENT + 5000)
    art = artifacts.create("document", "大きい", big)
    full = artifacts.get(art["id"])
    assert len(full["content"]) <= artifacts.MAX_CONTENT


# ── ツール: ドキュメント / スプレッドシート ────────────────────────
def test_create_document_tool_creates_artifact():
    before = len(artifacts.list_artifacts())
    r = tools.execute_tool("create_document", {"title": "議事録", "content": "本文です"})
    assert "議事録" in r
    items = artifacts.list_artifacts()
    assert len(items) == before + 1
    assert items[0]["title"] == "議事録" and items[0]["kind"] == "document"


def test_create_document_requires_content():
    assert "空" in tools.execute_tool("create_document", {"title": "x", "content": ""})


def test_create_spreadsheet_tool_from_rows():
    r = tools.execute_tool("create_spreadsheet", {"title": "家計", "rows": [["項目", "金額"], ["家賃", "80000"]]})
    assert "家計" in r
    art = next(i for i in artifacts.list_artifacts() if i["title"] == "家計")
    full = artifacts.get(art["id"])
    assert "項目,金額" in full["content"] and "家賃,80000" in full["content"]
    assert full["mime"] == "text/csv"


def test_create_spreadsheet_quotes_commas():
    tools.execute_tool("create_spreadsheet", {"title": "カンマ表", "rows": [["a,b", "c"]]})
    art = next(i for i in artifacts.list_artifacts() if i["title"] == "カンマ表")
    full = artifacts.get(art["id"])
    assert '"a,b"' in full["content"]  # カンマを含むセルはクォートされる


def test_create_spreadsheet_requires_data():
    assert "空" in tools.execute_tool("create_spreadsheet", {"title": "x"})


# ── エンドポイント ───────────────────────────────────────────────────
def test_artifacts_endpoints_roundtrip():
    art = artifacts.create("document", "EP文書", "内容ABC", "text/markdown")
    r = client.get("/artifacts")
    assert r.status_code == 200
    assert any(i["id"] == art["id"] for i in r.json()["items"])

    r2 = client.get(f"/artifacts/{art['id']}")
    assert r2.status_code == 200 and r2.json()["content"] == "内容ABC"

    r3 = client.delete(f"/artifacts/{art['id']}")
    assert r3.status_code == 200
    assert client.get(f"/artifacts/{art['id']}").status_code == 404


def test_artifact_get_missing_returns_404():
    assert client.get("/artifacts/nonexistent-xyz").status_code == 404


def test_artifact_update_content():
    art = artifacts.create("slides", "デッキ", '{"theme":"midnight","slides":[]}', "application/json")
    meta = artifacts.update(art["id"], content='{"theme":"sunset","slides":[]}')
    assert meta.get("id") == art["id"]
    full = artifacts.get(art["id"])
    assert '"sunset"' in full["content"]
    artifacts.delete(art["id"])


def test_artifact_update_endpoint():
    art = artifacts.create("document", "元タイトル", "本文", "text/markdown")
    r = client.patch(f"/artifacts/{art['id']}", json={"title": "新タイトル"})
    assert r.status_code == 200
    assert artifacts.get(art["id"])["title"] == "新タイトル"
    client.delete(f"/artifacts/{art['id']}")
