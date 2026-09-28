"""
変わったことを、開いている画面へすぐ届ける（仕様§38・events.py）。

見たいこと:
  ・会話で足したタスク・付箋が、開いている画面へ「変わった」として届く
  ・画面からの書き込みも同じ（スマホで足したら、ノートの画面にも出る）
  ・**他人には届かない**（流れは人ごと）
  ・中身は流さない（種類だけ。取り直しは、いつもの読み込みで）
  ・道具はワーカースレッドで動く。そこから流しても届く
"""

import asyncio
import json
import os
import sys
import threading

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import events
import main
import tools
from main import app

SECRET = "test-jwt-secret-for-events"


def token_for(sub: str) -> str:
    import jwt as pyjwt
    return pyjwt.encode({"sub": sub, "email": f"{sub}@example.com", "aud": "authenticated",
                         "exp": 9999999999}, SECRET, algorithm="HS256")


@pytest.fixture(autouse=True)
def clean():
    events._subs.clear()
    yield
    events._subs.clear()


@pytest.fixture
def loop():
    lp = asyncio.new_event_loop()
    asyncio.set_event_loop(lp)
    yield lp
    lp.close()


def _drain(lp, q, wait=0.05):
    """届いた物を取り出す（積むのは call_soon_threadsafe なので、ループを少し回す）。"""
    lp.run_until_complete(asyncio.sleep(wait))
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def test_開いている人にだけ_変わったと届く(loop):
    mine = loop.run_until_complete(_sub("alice"))
    other = loop.run_until_complete(_sub("bob"))
    assert events.publish("alice", "tasks") == 1
    got = _drain(loop, mine)
    assert [e["kind"] for e in got] == ["tasks"]
    assert _drain(loop, other) == [], "他人の変化が届いている"
    assert set(got[0]) == {"kind", "at"}, "中身を流している"


async def _sub(user):
    return events.subscribe(user)


def test_知らない種類は流さない(loop):
    q = loop.run_until_complete(_sub("alice"))
    assert events.publish("alice", "secrets") == 0
    assert _drain(loop, q) == []


def test_ワーカースレッドから流しても届く(loop):
    """道具は run_in_executor の先で動く。そこから積めないと、会話の変化が届かない。"""
    q = loop.run_until_complete(_sub("alice"))
    t = threading.Thread(target=lambda: events.publish("alice", "board"))
    t.start()
    t.join()
    assert [e["kind"] for e in _drain(loop, q)] == ["board"]


def test_開きすぎたら_古い流れから閉じる(loop):
    qs = [loop.run_until_complete(_sub("alice")) for _ in range(events.MAX_PER_USER + 1)]
    assert events.subscribers("alice") == events.MAX_PER_USER
    assert _drain(loop, qs[0]) == [None]          # 閉じての合図


def test_閉じたら_もう流さない(loop):
    q = loop.run_until_complete(_sub("alice"))
    events.unsubscribe("alice", q)
    assert events.publish("alice", "tasks") == 0 and events.subscribers("alice") == 0


def test_ログイン無しの1人運用でも_届く(loop):
    q = loop.run_until_complete(_sub(""))
    assert events.publish("", "tasks") == 1
    assert [e["kind"] for e in _drain(loop, q)] == ["tasks"]


# ── 会話の道具から ─────────────────────────────────────────────────
def test_会話でタスクを足すと_その人の画面に届く(loop, monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    q = loop.run_until_complete(_sub("alice"))
    token = config.bind_request_user("alice")
    try:
        tools.execute_tool("add_task", {"title": "牛乳を買う"})
    finally:
        config.reset_request_user(token)
    assert [e["kind"] for e in _drain(loop, q)] == ["tasks"]


def test_読むだけの道具では流さない(loop):
    q = loop.run_until_complete(_sub("alice"))
    token = config.bind_request_user("alice")
    try:
        tools.execute_tool("list_state", {})
    finally:
        config.reset_request_user(token)
    assert _drain(loop, q) == []


def test_変える道具は_どれも何が変わるかを持っている():
    """種類を書き忘れた道具は、会話で変えても画面に出ない。"""
    import risk
    changing = {t for t, lv in risk.LEVELS.items() if lv >= 1}
    # 外に残す物・手元のパソコン・手順は、画面の中身ではないので対象外
    outside = {"drive_upload", "google_doc", "google_sheet", "create_google_slides",
               "notion_add", "send_email", "local_list", "local_write", "local_append",
               "local_read", "obsidian_note", "browser_open", "browser_act",
               "recipe_run", "recipe_save", "recipe_delete", "run_workflow"}
    missing = sorted(changing - outside - set(events.TOOL_KINDS))
    assert not missing, f"変わった種類が決まっていない道具: {missing}"
    assert set(events.TOOL_KINDS.values()) <= events.KINDS


# ── 画面からの書き込み ─────────────────────────────────────────────
@pytest.fixture
def signed_in(monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(config, "REQUIRE_AUTH", False)
    monkeypatch.setattr(config, "APP_TOKEN", "")
    monkeypatch.setattr(config, "OWNER_EMAIL", "")
    monkeypatch.setattr(config, "OWNER_USER_ID", "")
    monkeypatch.setattr(config, "get_supabase", lambda: None)


def test_画面からの書き込みも_その人に届く(loop, signed_in, monkeypatch):
    monkeypatch.setattr(config, "storage_state", lambda: "personal")    # 保存先あり
    mine = loop.run_until_complete(_sub("alice"))
    other = loop.run_until_complete(_sub("bob"))
    r = TestClient(app).post("/tasks", json={"title": "牛乳を買う"},
                             headers={"Authorization": f"Bearer {token_for('alice')}"})
    assert r.status_code < 400, r.text
    assert [e["kind"] for e in _drain(loop, mine)] == ["tasks"]
    assert _drain(loop, other) == [], "他人の画面に流れている"


def test_断られた書き込みは流さない(loop, signed_in, monkeypatch):
    monkeypatch.setattr(config, "storage_state", lambda: "memory")      # 保存先なし → 409
    mine = loop.run_until_complete(_sub("alice"))
    r = TestClient(app).post("/tasks", json={"title": "牛乳を買う"},
                             headers={"Authorization": f"Bearer {token_for('alice')}"})
    assert r.status_code == 409
    assert _drain(loop, mine) == []


def test_道の頭で種類を決める():
    assert events.kind_for_path("/tasks") == "tasks"
    assert events.kind_for_path("/tasks/abc") == "tasks"
    assert events.kind_for_path("/tasksx") == ""          # 頭が一致するだけの別の道
    assert events.kind_for_path("/boards/b1") == "board"
    assert events.kind_for_path("/image/generate") == "artifacts"
    assert events.kind_for_path("/chat") == ""


# ── 流れそのもの ────────────────────────────────────────────────────
class _Req:
    async def is_disconnected(self):
        return False


def test_流れを開くと_挨拶のあとに変化が届き_何も無ければ合図だけ送る(loop, monkeypatch):
    """TestClient は応答を最後まで読んでから返すので、終わらない流れは直に回す。"""
    monkeypatch.setattr(main, "EVENTS_PING_SECONDS", 0.05)

    async def go():
        resp = await main.live_events(_Req(), user_id="", _auth=None)
        assert resp.media_type == "text/event-stream"
        it = resp.body_iterator
        first = await it.__anext__()
        assert json.loads(first[5:].strip()) == {"kind": "hello"}
        assert events.subscribers("") == 1
        events.publish("", "missions")
        got = await it.__anext__()
        assert json.loads(got[5:].strip())["kind"] == "missions"
        ping = await it.__anext__()                # 何も無いときは中身の無い合図
        assert ping.startswith(":")
        await it.aclose()
        assert events.subscribers("") == 0, "閉じた流れが残っている"

    loop.run_until_complete(go())
