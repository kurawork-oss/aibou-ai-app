# test_agent.py — HOME マルチステップ・エージェントのテスト
# =====================================================================
# llm.generate_text をスクリプト化してツールループの挙動を検証する。
# 実ツール（add_task 等）は Supabase 無し環境の in-memory フォールバックで動く。

from fastapi.testclient import TestClient

import agent
import llm
import tools
from main import app

client = TestClient(app)


def _scripted(*responses):
    """generate_text の戻り値を順番に返すフェイクを作る。"""
    it = iter(responses)

    def fake(prompt, **kwargs):
        try:
            return next(it)
        except StopIteration:
            return ""

    return fake


# ── ループ本体 ───────────────────────────────────────────────────────
def test_agent_runs_tool_then_reports(monkeypatch):
    """1手ツールを呼び、結果を踏まえて日本語で最終報告する。"""
    monkeypatch.setattr(llm, "generate_text", _scripted(
        '<<<TOOL_CALL>>>{"tool":"add_task","params":{"title":"牛乳を買う"}}',
        "タスク「牛乳を買う」を追加しました。",
    ))
    seen = {}

    def fake_execute(name, params):
        seen["call"] = (name, params)
        return "タスクを追加しました：牛乳を買う"

    monkeypatch.setattr(tools, "execute_tool", fake_execute)

    events = list(agent.run_stream("牛乳を買うのを忘れないようにして"))
    phases = [e["phase"] for e in events]

    assert phases[0] == "start"
    assert "tool" in phases and "observation" in phases and "final" in phases
    assert phases[-1] == "done"
    assert seen["call"][0] == "add_task"
    final = next(e for e in events if e["phase"] == "final")["text"]
    assert "牛乳" in final


def test_agent_plain_answer_uses_no_tool(monkeypatch):
    """行動不要の質問はツールを呼ばず普通に答える。"""
    monkeypatch.setattr(llm, "generate_text", _scripted("こんにちは。お手伝いできますよ。"))
    events = list(agent.run_stream("こんにちは"))
    phases = [e["phase"] for e in events]
    assert "tool" not in phases
    assert phases[-1] == "done"
    assert any(e["phase"] == "final" and "こんにちは" in e["text"] for e in events)


def test_agent_stops_at_max_steps(monkeypatch):
    """毎回ツールを呼び続けても MAX_STEPS で止まり、必ず final→done で終わる。"""
    monkeypatch.setattr(llm, "generate_text",
                        lambda prompt, **k: '<<<TOOL_CALL>>>{"tool":"list_state","params":{}}')
    monkeypatch.setattr(tools, "execute_tool", lambda name, params: "現在の状況：未完了タスク 0件")
    events = list(agent.run_stream("状況を整理して"))
    tool_events = [e for e in events if e["phase"] == "tool"]
    assert len(tool_events) == agent.MAX_STEPS
    done = next(e for e in events if e["phase"] == "done")
    assert done["steps"] == agent.MAX_STEPS
    assert any(e["phase"] == "final" for e in events)


def test_agent_empty_instruction():
    events = list(agent.run_stream("   "))
    assert events[-1]["phase"] == "done"
    assert any(e["phase"] == "final" for e in events)


def test_agent_generation_error_is_graceful(monkeypatch):
    def boom(prompt, **k):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(llm, "generate_text", boom)
    events = list(agent.run_stream("何かして"))
    phases = [e["phase"] for e in events]
    assert "error" in phases
    assert phases[-1] == "done"


# ── 新ツール（in-memory フォールバックで実行される） ──────────────────
def test_tool_add_task_then_list_state():
    r = tools.execute_tool("add_task", {"title": "テスト用タスクZZZ"})
    assert "テスト用タスクZZZ" in r
    state = tools.execute_tool("list_state", {})
    assert "テスト用タスクZZZ" in state


def test_tool_add_agenda():
    r = tools.execute_tool("add_agenda", {"title": "歯医者", "date": "2026-07-20", "time": "15:00"})
    assert "歯医者" in r and "2026-07-20" in r


def test_tool_add_task_requires_title():
    assert "空" in tools.execute_tool("add_task", {"title": ""})


def test_tool_notify_logs_internally_when_no_channel(monkeypatch):
    # 外部チャンネル未設定でも crash せず、記録した旨を返す。
    import keychain
    monkeypatch.setattr(keychain, "get_key", lambda name: "")
    r = tools.execute_tool("notify", {"message": "テスト通知"})
    assert "通知" in r


# ── エンドポイント ───────────────────────────────────────────────────
def test_agent_act_without_provider_streams_error():
    r = client.post("/agent/act", json={"instruction": "タスク追加して"})
    assert r.status_code == 200
    assert '"phase": "error"' in r.text or "error" in r.text


def test_agent_act_runs_with_provider(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "gemini")
    monkeypatch.setattr(llm, "generate_text", _scripted(
        '<<<TOOL_CALL>>>{"tool":"add_task","params":{"title":"領収書を整理"}}',
        "タスク「領収書を整理」を追加しました。",
    ))
    r = client.post("/agent/act", json={"instruction": "領収書を整理するタスクを追加して"})
    assert r.status_code == 200
    assert '"phase": "done"' in r.text
    assert "領収書" in r.text
