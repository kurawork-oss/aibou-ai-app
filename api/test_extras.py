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


# ── 曜日指定（weekly） ───────────────────────────────────────────────
def test_normalize_days():
    assert scheduler._normalize_days("daily") == "daily"
    assert scheduler._normalize_days("") == "daily"
    assert scheduler._normalize_days("mon, wed,FRI") == "mon,wed,fri"
    assert scheduler._normalize_days(["sat", "sun", "sat"]) == "sat,sun"
    assert scheduler._normalize_days("noday,xyz") == "daily"  # 全滅→daily


def test_runs_today_daily_and_weekday(monkeypatch):
    import datetime as dt
    # 2026-07-16 は木曜（thu）
    fixed = dt.datetime(2026, 7, 16, 9, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
    monkeypatch.setattr(scheduler, "_now", lambda: fixed)
    assert scheduler._runs_today("daily") is True
    assert scheduler._runs_today("thu") is True
    assert scheduler._runs_today("mon,thu") is True
    assert scheduler._runs_today("mon,fri") is False


def test_due_skips_wrong_weekday(monkeypatch):
    import datetime as dt
    fixed = dt.datetime(2026, 7, 16, 23, 59, tzinfo=dt.timezone(dt.timedelta(hours=9)))  # 木曜
    monkeypatch.setattr(scheduler, "_now", lambda: fixed)
    s_thu = scheduler.add("thursday job", "00:00", "thu")
    s_fri = scheduler.add("friday job", "00:00", "fri")
    due_ids = {d["id"] for d in scheduler._due(scheduler.list_schedules(1000))}
    assert s_thu["id"] in due_ids and s_fri["id"] not in due_ids
    scheduler.delete(s_thu["id"])
    scheduler.delete(s_fri["id"])


def test_schedule_add_tool_weekly_label():
    r = tools.execute_tool("schedule_add", {"instruction": "週次レビュー", "time": "09:00", "days": "mon,fri"})
    assert "毎週月・金" in r and "09:00" in r
    # cleanup（名前で探して削除）
    for s in scheduler.list_schedules(1000):
        if s.get("instruction") == "週次レビュー":
            scheduler.delete(s["id"])


def test_scheduler_endpoint_with_days():
    r = client.post("/scheduler", json={"instruction": "weekly x", "time": "10:00", "days": "sat,sun"})
    assert r.status_code == 200 and r.json()["days"] == "sat,sun"
    client.delete(f"/scheduler/{r.json()['id']}")


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
