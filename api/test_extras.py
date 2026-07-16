# test_extras.py — 画像生成 / ファイル抽出 / スケジューラ のテスト

from fastapi.testclient import TestClient

import artifacts
import fileread
import imagegen
import scheduler
import tools
from main import app

client = TestClient(app)


# ── 画像生成 ─────────────────────────────────────────────────────────
def test_imagegen_url():
    res = imagegen.generate("a cat on a roof")
    assert res["ok"] is True and "pollinations.ai" in res["url"]


def test_imagegen_empty():
    assert imagegen.generate("")["ok"] is False


def test_generate_image_tool_saves_image_artifact():
    before = len(artifacts.list_artifacts())
    r = tools.execute_tool("generate_image", {"prompt": "sunset over mountains"})
    assert "pollinations" in r
    items = artifacts.list_artifacts()
    assert len(items) == before + 1
    img = items[0]
    assert img["kind"] == "image" and (img.get("url") or "").startswith("https://image.pollinations")


# ── ファイル抽出 ─────────────────────────────────────────────────────
def test_fileread_text():
    assert fileread.extract_text("note.txt", b"hello aibou", "text/plain") == "hello aibou"


def test_fileread_pdf_error_graceful():
    out = fileread.extract_text("bad.pdf", b"not a real pdf", "application/pdf")
    assert out.startswith("(")  # 例外を握って説明文字列を返す


def test_file_extract_endpoint():
    r = client.post("/file/extract", files={"file": ("note.txt", b"hello aibou", "text/plain")})
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "hello aibou" and body["chars"] == 11


# ── スケジューラ ─────────────────────────────────────────────────────
def test_scheduler_add_list_delete():
    s = scheduler.add("test instruction", "07:00")
    assert s["time"] == "07:00"
    assert any(i["id"] == s["id"] for i in scheduler.list_schedules())
    scheduler.delete(s["id"])
    assert not any(i["id"] == s["id"] for i in scheduler.list_schedules())


def test_scheduler_add_requires_instruction():
    assert scheduler.add("", "07:00").get("error")


def test_scheduler_tick_runs_due_once(monkeypatch):
    import agent
    import notify
    s = scheduler.add("morning news", "00:00")  # 00:00 は常に「時刻を過ぎている」
    monkeypatch.setattr(agent, "run_stream",
                        lambda instruction, approval=False: iter([{"phase": "final", "text": "done news"}]))
    monkeypatch.setattr(notify, "notify_all", lambda msg: {"ok": True})

    res = scheduler.tick()
    assert any(r["instruction"] == "morning news" for r in res["ran"])
    # 同日2回目は再実行しない（last_run で抑止）
    res2 = scheduler.tick()
    assert all(r["instruction"] != "morning news" for r in res2["ran"])
    scheduler.delete(s["id"])


def test_scheduler_endpoints():
    r = client.post("/scheduler", json={"instruction": "daily x", "time": "09:00"})
    assert r.status_code == 200 and r.json()["time"] == "09:00"
    sid = r.json()["id"]
    assert any(i["id"] == sid for i in client.get("/scheduler").json()["items"])
    assert client.delete(f"/scheduler/{sid}").status_code == 200


def test_scheduler_tick_endpoint(monkeypatch):
    import agent
    import notify
    monkeypatch.setattr(agent, "run_stream", lambda instruction, approval=False: iter([{"phase": "final", "text": "x"}]))
    monkeypatch.setattr(notify, "notify_all", lambda m: {"ok": True})
    r = client.post("/scheduler/tick")
    assert r.status_code == 200 and "ran" in r.json()
