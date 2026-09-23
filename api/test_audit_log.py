"""
操作の記録（audit.py）を見張る。

ここで守りたいこと
------------------
1. あなたの代わりに**外で**したことは、必ず1行残る（段階2以上と、手元・
   ブラウザ・手順の道具）。読むだけの道具は残さない（肝心の行が埋もれる）
2. どこから頼まれたか・確認して押したかが残る（確認なしで動いた物を拾える）
3. **本文は残さない**。宛先やURLに混ざった鍵は伏せる
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audit


@pytest.fixture(autouse=True)
def clean():
    audit._mem._by_tenant.clear()
    yield
    audit._mem._by_tenant.clear()


def _run(tool, params, result, level, **route):
    with audit.route(**route) if route else _nothing():
        rec = audit.begin(tool, params)
        return audit.end(rec, result, level)


class _nothing:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_outside_changes_are_always_kept():
    row = _run("send_email", {"to": "boss@example.com", "body": "本文です"},
               "送信しました", 3, source="agent", instruction="上司に報告して")
    assert row["tool"] == "send_email" and row["target"] == "boss@example.com"
    assert row["source"] == "agent" and row["instruction"] == "上司に報告して"
    assert row["ok"] is True
    assert audit.recent(10)[0]["id"] == row["id"]


def test_your_belongings_are_kept_even_when_light():
    """手元のフォルダを見るのは段階1でも、あなたの持ち物に触っている。"""
    assert _run("local_list", {"path": "メモ"}, "3件", 1) is not None


def test_reading_only_is_not_kept():
    assert _run("web_search", {"query": "天気"}, "結果", 0) is None
    assert audit.recent(10) == []


def test_the_body_is_never_kept():
    row = _run("send_email", {"to": "a@example.com", "body": "社外秘の本文"},
               "送信しました", 3)
    assert "社外秘" not in str(row)


def test_keys_in_targets_are_masked():
    row = _run("browser_open", {"url": "https://x.example/?k=AIzaSyA-1234567890abcdefghijklmnopqrstu"},
               "開きました", 2)
    assert "AIza" not in row["target"] and "伏せました" in row["target"]


def test_whether_a_person_approved_is_kept():
    row = _run("send_email", {"to": "a@example.com"}, "送信しました", 3,
               source="approve", approved=True)
    assert row["approved"] is True and audit.label_of(row["source"]) == "承認ボタン"
    row = _run("calendar_add", {"title": "会議"}, "追加しました", 2, source="agent")
    assert row["approved"] is False


def test_the_tool_can_say_where_and_whether_it_worked():
    """文から推し量るより、道具が言うほうが確か。"""
    with audit.route(source="chat"):
        rec = audit.begin("recipe_run", {"name": "朝のケース確認"})
        audit.note(ok=False, where="ノート / 専用ブラウザ")
        row = audit.end(rec, "手順「朝のケース確認」は流しきれませんでした", 3)
    assert row["ok"] is False and row["where"] == "ノート / 専用ブラウザ"
    assert row["target"] == "朝のケース確認"


def test_failure_is_read_from_the_result_when_not_told():
    row = _run("calendar_add", {"title": "会議"}, "予定の追加に失敗しました：権限", 2)
    assert row["ok"] is False


def test_a_note_outside_a_run_does_nothing():
    audit.note(ok=True, where="どこか")        # 落ちない・何も残らない
    assert audit.recent(10) == []


def test_unknown_sources_are_not_invented():
    row = _run("send_email", {"to": "a@example.com"}, "送信しました", 3,
               source="でたらめ")
    assert row["source"] == "direct"


def test_it_keeps_only_so_many_in_memory():
    for i in range(audit.MAX_MEM + 5):
        _run("local_list", {"path": f"f{i}"}, "ok", 1)
    assert len(list(audit._mem)) == audit.MAX_MEM
    assert audit.recent(1)[0]["target"] == f"f{audit.MAX_MEM + 4}"


# ── 入口ごとに、正しく残るか ──────────────────────────────────────────

import json  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

import localagent  # noqa: E402
import tools  # noqa: E402


@pytest.fixture
def fake_calendar(monkeypatch):
    """外に残る道具（段階2）の代わり。本物の Google には行かない。"""
    monkeypatch.setitem(tools._DISPATCH, "calendar_add",
                        lambda p: f"予定「{p.get('title')}」を追加しました")
    monkeypatch.setitem(tools._DISPATCH, "notify", lambda p: "通知を送りました")


def test_the_agent_loop_records_what_it_did_without_asking(monkeypatch, fake_calendar):
    import agent
    decisions = iter([
        {"call": {"tool": "calendar_add", "params": {"title": "歯医者", "date": "2026-10-01"}},
         "text": ""},
        {"call": None, "text": "入れました"},
    ])
    monkeypatch.setattr(agent.toolcall, "decide", lambda *a, **k: next(decisions))
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    list(agent.run_stream("1日に歯医者を入れて", approval=False))
    row = audit.recent(1)[0]
    assert row["tool"] == "calendar_add" and row["target"] == "歯医者"
    assert row["source"] == "agent" and row["approved"] is False
    assert row["instruction"] == "1日に歯医者を入れて"


def test_a_scheduled_run_is_told_apart(monkeypatch, fake_calendar):
    import agent
    decisions = iter([
        {"call": {"tool": "calendar_add", "params": {"title": "定例", "date": "2026-10-01"}},
         "text": ""},
        {"call": None, "text": "入れました"},
    ])
    monkeypatch.setattr(agent.toolcall, "decide", lambda *a, **k: next(decisions))
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    list(agent.run_stream("定例を入れて", approval=False, source="schedule"))
    assert audit.recent(1)[0]["source"] == "schedule"


def test_the_approve_button_is_recorded_as_approved(fake_calendar):
    from main import app
    TestClient(app).post("/agent/execute", json={
        "tool": "calendar_add", "params": {"title": "会議", "date": "2026-10-01"}, "level": 2})
    row = audit.recent(1)[0]
    assert row["source"] == "approve" and row["approved"] is True and row["ok"] is True


def test_an_approval_from_the_notification_is_recorded(fake_calendar):
    import approvals
    row = approvals.create("calendar_add", {"title": "朝会", "date": "2026-10-01"},
                           note="定期実行「朝会を入れて」の途中で確認が要ります", level=2)
    approvals.answer_signed_in(row["id"], "approve")
    got = audit.recent(1)[0]
    assert got["source"] == "push" and got["approved"] is True
    assert "朝会を入れて" in got["instruction"]


def test_a_hash_command_is_recorded_as_typed_by_you(fake_calendar):
    from main import app
    TestClient(app).post("/command", json={"text": "#通知 こんばんは"})
    row = audit.recent(1)[0]
    assert row["tool"] == "notify" and row["source"] == "command"


def test_the_chat_records_what_it_ran(monkeypatch, fake_calendar):
    import main
    monkeypatch.setattr(main.llm, "active_provider", lambda: "gemini")
    monkeypatch.setattr(main, "mem_recall", lambda *_a, **_k: "")
    monkeypatch.setattr(main, "mem_add", lambda *_a, **_k: None)
    call = tools.TOOL_CALL_MARKER + json.dumps(
        {"tool": "calendar_add", "params": {"title": "歯医者", "date": "2026-10-01"}},
        ensure_ascii=False)
    monkeypatch.setattr(main.llm, "stream_text", lambda *_a, **_k: iter([call, "はい"]))
    TestClient(main.app).post("/chat", json={"message": "歯医者を入れて", "approval": False})
    row = audit.recent(1)[0]
    assert row["source"] == "chat" and row["instruction"] == "歯医者を入れて"


def test_your_device_and_browser_are_named(monkeypatch):
    """あなたとして押した物は、どの台・どのブラウザだったかまで残る。"""
    localagent.reset()
    got = localagent.pair("local", "ノート")
    localagent.take("local", got["device"], wait=0.01)
    localagent.note_engines("local", got["device"], ["playwright"])
    localagent.note_sites("local", got["device"], ["intra.example.co.jp"])
    monkeypatch.setattr(tools, "_local", lambda *a, **k: {
        "ok": True, "title": "一覧", "url": "https://intra.example.co.jp/", "text": "x",
        "device_name": "ノート", "engine_label": "専用ブラウザ（Playwright）"})
    import risk
    with risk.ceiling(3), audit.route("approve", approved=True):
        tools.execute_tool("browser_act", {"url": "https://intra.example.co.jp/",
                                           "steps": [{"do": "click", "target": "送信"}]})
    row = audit.recent(1)[0]
    assert row["where"] == "ノート / 専用ブラウザ（Playwright）"
    assert row["level"] == 3 and row["ok"] is True
    localagent.reset()


def test_a_refused_move_is_recorded_as_not_done(monkeypatch):
    """場所が無くて動かなかった物は「できなかった」で残る（できた顔をしない）。"""
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    localagent.reset()
    tools.execute_tool("browser_act", {"url": "https://intra.example.co.jp/",
                                       "steps": [{"do": "click", "target": "送信"}]})
    row = audit.recent(1)[0]
    assert row["tool"] == "browser_act" and row["ok"] is False


def test_nothing_is_recorded_when_nothing_happened():
    """引数の形で断った物は、何も起きていないので残さない。"""
    tools.execute_tool("send_email", {"body": "宛先なし"})
    assert audit.recent(5) == []


def test_the_screen_can_read_the_record(fake_calendar):
    from main import app
    client = TestClient(app)
    client.post("/agent/execute", json={
        "tool": "calendar_add", "params": {"title": "会議", "date": "2026-10-01"}})
    items = client.get("/audit").json()["items"]
    assert items[0]["tool"] == "calendar_add"
    assert items[0]["source_label"] == "承認ボタン"
