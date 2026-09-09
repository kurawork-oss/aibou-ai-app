# test_setup_flow.py — 設定で会話を終わらせず、元の用事に戻ること
#
# これまで:
#   「Notionから資料探して」→ 未接続 → 道具が「未設定です」と返す →
#   AIがそのまま伝える → 会話が終わる。
#   利用者は設定を探し、済んだら**同じ頼みごとをもう一度言う**。
#   この最後の一手間が、設定でいちばんいらないもの。
#
# いま:
#   未接続だと分かった時点で用事を預かり、繋ぐ入口を出す。
#   繋がったら預けた用事を返す。

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent
import config
import oauth
import setup_flow
import tools
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean():
    setup_flow._mem.clear()
    yield
    setup_flow._mem.clear()


# ── モデルの応答を模す ───────────────────────────────────────────────
class _FC:
    def __init__(self, n, a): self.name, self.args = n, a


class _Part:
    def __init__(self, text="", fc=None): self.text, self.function_call = text, fc


class _Resp:
    def __init__(self, parts):
        c = type("C", (), {"parts": parts})()
        self.candidates = [type("Cd", (), {"content": c})()]


def _connected_state(**over):
    base = {"key": "notion", "label": "Notion", "configured": True,
            "connected": False, "unlocks": ["決めたページにメモを書き足す"]}
    base.update(over)
    return base


@pytest.fixture
def notion_missing(monkeypatch):
    monkeypatch.setattr(oauth, "status", lambda p: _connected_state())
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    monkeypatch.setattr(
        config, "generate_resilient",
        lambda p, tools=None, **k: _Resp([_Part(fc=_FC(
            "notion_add", {"title": "議事録", "content": "本文"}))]))


# ── 1. 未接続を見分ける ──────────────────────────────────────────────
@pytest.mark.parametrize("text,want", [
    ("Notion未設定です。拡張機能から…", "notion"),
    ("GitHub未設定です。拡張機能から…", "github"),
    ("Google未接続です。拡張機能から…", "google"),
    ("Slackのトークン（SLACK_BOT_TOKEN）が未設定です", "slack"),
    ("タスクを追加しました：牛乳", ""),
    ("ツール実行エラー（add_task）：想定外", ""),
])
def test_only_a_missing_connection_is_treated_as_setup(text, want):
    """本当のエラーを「設定すれば直る」と言い出さないこと。

    何でも設定のせいにすると、原因の取り違えを増やす。
    """
    assert setup_flow.detect(text) == want


def test_the_tool_messages_still_carry_the_sign():
    """道具の文言を書き換えても、見分けの目印が消えていないこと。"""
    import gservice
    assert setup_flow.detect(
        tools.execute_tool("notion_add", {"title": "x", "content": "y"})) == "notion"
    assert setup_flow.detect(gservice._err_not_connected()["error"]) == "google"


# ── 2. 会話が設定で終わらない ────────────────────────────────────────
def test_the_conversation_offers_to_connect_instead_of_stopping(notion_missing):
    events = list(agent.run_stream("Notionに議事録をメモして"))
    kinds = [e["phase"] for e in events]
    assert "setup_required" in kinds

    need = next(e for e in events if e["phase"] == "setup_required")
    assert need["provider"] == "notion"
    assert need["can_connect"] is True
    assert need["connect_path"] == "/connect/notion/start"

    final = next(e for e in events if e["phase"] == "final")["text"]
    # 仕様書の言う4つが入っていること
    assert "繋がっていない" in final                    # なぜできないか
    assert "メモを書き足す" in final                    # 繋ぐと何ができるか
    assert "Notionに議事録をメモして" in final          # 元の用事を覚えている
    assert "繋ぎますか" in final                        # いま繋ぐか

    assert next(e for e in events if e["phase"] == "done")["awaiting_setup"] is True


def test_the_original_request_is_held(notion_missing):
    list(agent.run_stream("Notionに議事録をメモして"))
    st = setup_flow.status()
    assert st["waiting"] is True
    assert st["instruction"] == "Notionに議事録をメモして"
    assert st["provider"] == "notion"


def test_a_held_request_comes_back_once_and_only_once(notion_missing):
    list(agent.run_stream("Notionに議事録をメモして"))
    got = setup_flow.take("notion")
    assert got["instruction"] == "Notionに議事録をメモして"
    assert got["tool"] == "notion_add"
    assert got["params"]["title"] == "議事録"
    # 二度は戻らない（同じ用事が二重に走らない）
    assert setup_flow.take("notion") is None


def test_a_stale_request_is_dropped(notion_missing, monkeypatch):
    """何日も前の頼みごとが、繋いだ瞬間に突然動くのは怖い。"""
    list(agent.run_stream("Notionに議事録をメモして"))
    monkeypatch.setattr(setup_flow, "_now",
                        lambda: 10 ** 10 + setup_flow.HOLD_TTL + 1)
    assert setup_flow.pending() is None
    assert setup_flow.status()["waiting"] is False


# ── 3. 利用者では直せないことは、そう言う ────────────────────────────
def test_when_the_owner_has_not_registered_the_app_it_says_so(monkeypatch):
    """アプリ登録がまだなら、利用者に繋がせようとしないこと。

    「繋いでください」と言われても押せる物が無い、が一番詰まる。
    """
    monkeypatch.setattr(oauth, "status",
                        lambda p: _connected_state(configured=False))
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    monkeypatch.setattr(
        config, "generate_resilient",
        lambda p, tools=None, **k: _Resp([_Part(fc=_FC(
            "notion_add", {"title": "x", "content": "y"}))]))

    events = list(agent.run_stream("Notionにメモして"))
    need = next(e for e in events if e["phase"] == "setup_required")
    assert need["can_connect"] is False and need["needs_owner"] is True
    final = next(e for e in events if e["phase"] == "final")["text"]
    assert "持ち主" in final
    # 押せないので、用事も預からない（繋がる見込みが無い）
    assert setup_flow.status()["waiting"] is False


# ── 4. 勝手に再開してはいけないもの ──────────────────────────────────
@pytest.mark.parametrize("tool,auto", [
    ("notion_add", True),
    ("calendar_add", True),
    ("send_email", False),      # 送ってしまうと取り返せない
    ("notify", False),
    ("enqueue_income", False),
])
def test_irreversible_work_is_not_resumed_silently(tool, auto):
    """「連携したら勝手にメールが飛んだ」を作らないこと。"""
    row = setup_flow.hold("なにかして", "google", tool, {})
    assert setup_flow.can_auto_resume(row) is auto


# ── 5. 入口（HTTP） ─────────────────────────────────────────────────
def test_pending_and_resume_endpoints(notion_missing):
    assert client.get("/setup/pending").json()["waiting"] is False

    list(agent.run_stream("Notionに議事録をメモして"))
    st = client.get("/setup/pending").json()
    assert st["waiting"] is True and st["auto_resume"] is True

    got = client.post("/setup/resume").json()
    assert got["ok"] is True
    assert got["instruction"] == "Notionに議事録をメモして"
    assert got["auto"] is True

    # 取り出したら空になる
    assert client.get("/setup/pending").json()["waiting"] is False
    assert client.post("/setup/resume").json()["ok"] is False


def test_resume_does_not_execute_by_itself(notion_missing):
    """再開の入口は、指示を返すだけで実行しないこと。

    ここで実行してしまうと、承認の仕組みを通らずに動く道ができる。
    """
    list(agent.run_stream("Notionに議事録をメモして"))
    got = client.post("/setup/resume").json()
    assert "result" not in got and "tool" not in got


def test_a_broken_setup_flow_never_stops_the_conversation(monkeypatch):
    """この仕組みが壊れても、会話は続くこと。"""
    def boom(*a, **k):
        raise RuntimeError("預かりの仕組みが壊れている")
    monkeypatch.setattr(setup_flow, "blocked", boom)
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    monkeypatch.setattr(
        config, "generate_resilient",
        lambda p, tools=None, **k: _Resp([_Part(fc=_FC(
            "notion_add", {"title": "x", "content": "y"}))]))

    events = list(agent.run_stream("Notionにメモして"))
    assert any(e["phase"] == "final" for e in events)
    assert any(e["phase"] == "done" for e in events)
