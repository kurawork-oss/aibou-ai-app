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
