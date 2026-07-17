# test_board.py — ホワイトボード + プロジェクト管理拡張のテスト

from fastapi.testclient import TestClient

import board
import tasks
import tools
from main import app

client = TestClient(app)


# ── board.py（in-memory フォールバック） ─────────────────────────────
def test_board_save_and_get_roundtrip():
    n1 = {"id": "n1", "x": 10, "y": 20, "text": "アイデアA", "color": "cyan", "w": 200}
    n2 = {"id": "n2", "x": 300, "y": 20, "text": "アイデアB", "color": "yellow", "w": 200}
    res = board.save_board([n1, n2], [{"id": "e1", "from": "n1", "to": "n2"}])
    assert res["ok"] is True
    b = board.get_board()
    assert len(b["nodes"]) == 2 and len(b["edges"]) == 1
    assert b["nodes"][0]["text"] == "アイデアA"


def test_board_sanitize_drops_orphan_edges():
    res = board.save_board(
        [{"id": "a", "x": 0, "y": 0, "text": "x", "color": "green"}],
        [{"id": "e", "from": "a", "to": "missing"}, {"id": "e2", "from": "a", "to": "a"}],
    )
    assert res["edges"] == []


def test_board_add_note_positions_grid():
    board.save_board([], [])
    r1 = board.add_note("メモ1")
    r2 = board.add_note("メモ2", "cyan")
    assert r1["ok"] and r2["ok"] and r2["count"] == 2
    b = board.get_board()
    assert b["nodes"][0]["x"] != b["nodes"][1]["x"]  # グリッドで横にずれる


def test_board_add_note_requires_text():
    assert board.add_note("").get("error")


# ── エンドポイント ───────────────────────────────────────────────────
def test_board_endpoints_roundtrip():
    r = client.post("/board", json={"nodes": [{"id": "z1", "x": 1, "y": 2, "text": "EP", "color": "pink"}], "edges": []})
    assert r.status_code == 200 and r.json()["ok"] is True
    g = client.get("/board")
    assert g.status_code == 200
    assert any(n["id"] == "z1" for n in g.json()["nodes"])


# ── tools ────────────────────────────────────────────────────────────
def test_tool_board_add_note():
    r = tools.execute_tool("board_add_note", {"text": "ブレストの種", "color": "purple"})
    assert "付箋" in r and "BOARD" in r


# ── 複数ボード ───────────────────────────────────────────────────────
def test_multi_board_crud():
    b1 = board.create_board("企画ボード")
    b2 = board.create_board("開発ボード")
    metas = board.list_boards()
    names = [m["name"] for m in metas]
    assert "企画ボード" in names and "開発ボード" in names

    # 保存はボードごとに独立
    board.save_board([{"id": "k1", "x": 0, "y": 0, "text": "企画メモ", "color": "cyan"}], [], b1["id"])
    assert any(n["text"] == "企画メモ" for n in board.get_board(b1["id"])["nodes"])
    assert not any(n.get("text") == "企画メモ" for n in board.get_board(b2["id"])["nodes"])

    # rename / duplicate / delete
    board.rename_board(b2["id"], "開発2")
    assert board.get_board(b2["id"])["name"] == "開発2"
    dup = board.duplicate_board(b1["id"])
    assert dup["ok"] and "copy" in dup["name"]
    assert any(n["text"] == "企画メモ" for n in board.get_board(dup["id"])["nodes"])
    for bid in (b1["id"], b2["id"], dup["id"]):
        board.delete_board(bid)
    assert board.get_board(b1["id"]).get("error")


def test_board_get_missing_returns_error():
    assert board.get_board("nonexistent-id").get("error")


def test_node_kind_and_height_sanitized():
    res = board.save_board(
        [{"id": "s1", "x": 0, "y": 0, "text": "枠", "color": "cyan", "kind": "frame", "h": 240},
         {"id": "s2", "x": 0, "y": 0, "text": "?", "color": "cyan", "kind": "invalid-kind"}],
        [],
    )
    kinds = {n["id"]: n["kind"] for n in res["nodes"]}
    assert kinds["s1"] == "frame" and kinds["s2"] == "sticky"
    assert next(n for n in res["nodes"] if n["id"] == "s1")["h"] == 240


def test_add_note_targets_named_board():
    b = board.create_board("ターゲット企画")
    r = tools.execute_tool("board_add_note", {"text": "狙い撃ちメモ", "board": "ターゲット"})
    assert "ターゲット企画" in r
    assert any(n["text"] == "狙い撃ちメモ" for n in board.get_board(b["id"])["nodes"])
    board.delete_board(b["id"])


def test_boards_endpoints_roundtrip():
    r = client.post("/boards", json={"name": "EPボード"})
    assert r.status_code == 200
    bid = r.json()["id"]
    assert any(m["id"] == bid for m in client.get("/boards").json()["items"])
    assert client.post(f"/boards/{bid}", json={"nodes": [{"id": "e1", "x": 0, "y": 0, "text": "x", "color": "green"}], "edges": []}).status_code == 200
    assert client.get(f"/boards/{bid}").json()["nodes"][0]["text"] == "x"
    assert client.patch(f"/boards/{bid}", json={"name": "EP2"}).status_code == 200
    dup = client.post(f"/boards/{bid}/duplicate")
    assert dup.status_code == 200 and dup.json()["ok"]
    client.delete(f"/boards/{dup.json()['id']}")
    assert client.delete(f"/boards/{bid}").status_code == 200
    assert client.get(f"/boards/{bid}").status_code == 404


def test_tool_complete_task_by_partial_title():
    tasks.create_task("牛乳を買う（テスト）")
    r = tools.execute_tool("complete_task", {"title": "牛乳"})
    assert "完了" in r
    all_tasks = tasks.list_tasks(None, 1000)
    t = next(t for t in all_tasks if "牛乳を買う（テスト）" in t["title"])
    assert t["status"] == "completed"
    tasks.delete_task(t["id"])


def test_tool_complete_task_not_found():
    r = tools.execute_tool("complete_task", {"title": "存在しないタスク___"})
    assert "見つかりません" in r


# ── tasks 拡張フィールド ─────────────────────────────────────────────
def test_task_priority_due_project_fields():
    t = tasks.create_task("優先タスク", "", "pending", "high", "2026-08-01", "副業")
    assert t["priority"] == "high" and t["due"] == "2026-08-01" and t["project"] == "副業"
    u = tasks.update_task(t["id"], priority="low", due="2026-09-01", project="生活")
    assert u["priority"] == "low" and u["due"] == "2026-09-01" and u["project"] == "生活"
    tasks.delete_task(t["id"])


def test_task_invalid_priority_defaults_to_mid():
    t = tasks.create_task("優先度不正", priority="urgent")
    assert t["priority"] == "mid"
    tasks.delete_task(t["id"])


def test_task_endpoint_with_new_fields():
    r = client.post("/tasks", json={"title": "EPタスク", "priority": "high", "due": "2026-08-15", "project": "開発"})
    assert r.status_code == 200
    t = r.json()
    assert t["priority"] == "high" and t["project"] == "開発"
    r2 = client.patch(f"/tasks/{t['id']}", json={"priority": "low"})
    assert r2.status_code == 200 and r2.json()["priority"] == "low"
    client.delete(f"/tasks/{t['id']}")
