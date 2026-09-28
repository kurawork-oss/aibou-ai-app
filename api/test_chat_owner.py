"""
持ち主専用の道具は、会話からも持ち主だけが使えること。

見つけた穴
----------
副業・AI STUDIO は、HTTPの入口（/income/*・/studio/*）では require_owner で
塞いでいた（test_owner_only.py）。ところが会話の道具は入口を通らず、
モジュールを直接呼ぶ。しかも

  ・AIに渡す道具の一覧は、いつも「持ち主のつもり」で作っていた
  ・承認ボタンの入口（/agent/execute）は、どの道具名でも実行していた

ので、持ち主でない人が /agent/execute に enqueue_income を送れば、副業の
処理が動いた。入口で判定した「持ち主か」を道具の側まで運び、道具の一覧
と実行の両方で見る。
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import capabilities as cap
import config
import income
import keychain
import newsletter
import present
import pseo
import risk
import studio
import tools
from main import app

client = TestClient(app)
SECRET = "test-jwt-secret-for-owner-tools"
OWNER_TOOLS = {"enqueue_income", "income_status", "seo_pages", "newsletter_draft", "run_workflow"}


def token_for(sub: str, email: str) -> str:
    import jwt as pyjwt
    return pyjwt.encode({"sub": sub, "email": email, "aud": "authenticated",
                         "exp": 9999999999}, SECRET, algorithm="HS256")


@pytest.fixture
def owner_is_set(monkeypatch):
    """持ち主を決めてある構成（人に配るときの形）。"""
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(config, "OWNER_EMAIL", "boss@example.com")
    monkeypatch.setattr(config, "OWNER_USER_ID", "")
    monkeypatch.setattr(config, "REQUIRE_AUTH", False)
    monkeypatch.setattr(config, "APP_TOKEN", "")
    monkeypatch.setattr(config, "get_supabase", lambda: None)


@pytest.fixture
def enqueued(monkeypatch):
    got = []
    monkeypatch.setattr(income, "enqueue", lambda theme: got.append(theme) or {"id": "j1"})
    return got


@pytest.fixture
def live():
    """起動処理まで通したクライアント。

    道具は run_in_executor でワーカースレッドへ逃がして動く。「誰のリクエストか」
    をそこまで運ぶ実行先は、起動時（lifespan）に差し替えている
    （config.install_context_executor）。起動を通さないと本番と違う道になる。
    """
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clean():
    keychain.delete_key("FEATURE_PACKS")
    keychain._mem_keys.clear()
    yield
    keychain.delete_key("FEATURE_PACKS")
    keychain._mem_keys.clear()


# ── 承認ボタンの入口から、持ち主専用の道具を動かせない ───────────────────
def test_持ち主でない人は_承認の入口から副業を動かせない(owner_is_set, enqueued, live):
    r = live.post("/agent/execute", json={"tool": "enqueue_income", "params": {"theme": "x"}},
                    headers={"Authorization": f"Bearer {token_for('emp-1', 'emp@example.com')}"})
    assert r.status_code == 200
    assert "持ち主だけ" in r.json()["result"]
    assert enqueued == [], "持ち主でない人の頼みで、副業の処理が動いた"


def test_持ち主は_これまで通り動かせる(owner_is_set, enqueued, live):
    r = live.post("/agent/execute", json={"tool": "enqueue_income", "params": {"theme": "x"}},
                    headers={"Authorization": f"Bearer {token_for('boss-1', 'boss@example.com')}"})
    assert "投入しました" in r.json()["result"] and enqueued == ["x"]


def test_持ち主を決めていない1人運用では_全部使える(monkeypatch, enqueued, live):
    """設定し忘れで自分が締め出されないこと（test_owner_only.py と同じ考え方）。"""
    monkeypatch.setattr(config, "OWNER_EMAIL", "")
    monkeypatch.setattr(config, "OWNER_USER_ID", "")
    r = live.post("/agent/execute", json={"tool": "enqueue_income", "params": {"theme": "x"}})
    assert "投入しました" in r.json()["result"]


# ── AIに渡す道具の一覧 ───────────────────────────────────────────────
def test_持ち主でない人のAIには_持ち主専用の道具を渡さない():
    cap.set_packs(["core", "make", "income"])       # 副業のかたまりを保存していても
    token = config.bind_request_owner(False)
    try:
        offered = cap.enabled_tools()
        assert not (offered & OWNER_TOOLS), f"渡っている: {offered & OWNER_TOOLS}"
        assert "add_task" in offered and "create_lp" in offered   # ほかは渡る
        assert "run_workflow" not in cap.tools_doc()
    finally:
        config.reset_request_owner(token)


def test_持ち主のAIには渡る():
    cap.set_packs(["core", "make", "income"])
    token = config.bind_request_owner(True)
    try:
        assert OWNER_TOOLS <= cap.enabled_tools()
    finally:
        config.reset_request_owner(token)


def test_持ち主でない人の_シャープの一覧にも出ない():
    cap.set_packs(["core", "make", "income"])
    names = {c["cmd"] for c in cap.available(is_owner=False)}
    assert "ワークフロー" not in names and "副業" not in names
    assert "ワークフロー" in {c["cmd"] for c in cap.available(is_owner=True)}


def test_道具を直に呼んでも_持ち主でなければ断る(enqueued):
    token = config.bind_request_owner(False)
    try:
        assert "持ち主だけ" in tools.execute_tool("enqueue_income", {"theme": "x"})
        assert "持ち主だけ" in tools.execute_tool("run_workflow", {"name": "週報"})
    finally:
        config.reset_request_owner(token)
    assert enqueued == []


# ── ワークフロー・SEOページ・ニュースレター ─────────────────────────────
def _run(name, params):
    token = present.begin()
    try:
        return tools.execute_tool(name, params), present.take()
    finally:
        present.end(token)


def test_ワークフローを名前で流して_結果を出す(monkeypatch):
    monkeypatch.setattr(studio, "list_workflows", lambda: [
        {"id": "w1", "name": "週報まとめ"}, {"id": "w2", "name": "議事録"}])
    ran = []

    def fake_run(wf_id, text=""):
        ran.append((wf_id, text))
        return {"workflow_name": "週報まとめ", "ran": 2, "final_output": "今週の要点は3つ",
                "results": [{"step": 1, "name": "要約", "type": "ai_generate", "ok": True},
                            {"step": 2, "name": "整形", "type": "ai_generate", "ok": True}]}
    monkeypatch.setattr(studio, "run_workflow", fake_run)
    out, made = _run("run_workflow", {"name": "週報", "input": "やったこと"})
    assert ran == [("w1", "やったこと")]
    assert "「週報まとめ」を流しました（2手）" in out and "今週の要点は3つ" in out
    assert made[0]["kind"] == "document"


def test_ワークフローが1つに絞れないときは流さない(monkeypatch):
    monkeypatch.setattr(studio, "list_workflows", lambda: [
        {"id": "w1", "name": "週報A"}, {"id": "w2", "name": "週報B"}])
    monkeypatch.setattr(studio, "run_workflow", lambda *a: pytest.fail("流してはいけない"))
    out, _ = _run("run_workflow", {"name": "週報"})
    assert "1つに絞れません" in out and "週報A" in out and "週報B" in out


def test_ワークフローを流すのは_毎回確かめる():
    """自動化と同じ仕組みで、通知の手順があれば実際に届く。"""
    assert risk.level("run_workflow") == 3
    assert risk.describe("run_workflow")["always_confirm"] is True


def test_SEOページは下書きまで_公開はしない(monkeypatch):
    got = {}

    def fake(axes, template="", limit=5):
        got.update(axes=axes, template=template, limit=limit)
        return {"ok": True, "count": 2, "failed": [],
                "created": [{"slug": "tokyo", "title": "東京の歯医者"},
                            {"slug": "osaka", "title": "大阪の歯医者"}]}
    monkeypatch.setattr(pseo, "generate_batch", fake)
    out, _ = _run("seo_pages", {"axes": [["東京", "大阪"], ["歯医者"]], "limit": 50})
    assert got["axes"] == [["東京", "大阪"], ["歯医者"]] and got["limit"] == 10   # 10まで
    assert "下書きを2件作りました（公開はしていません）" in out and "/tokyo" in out


def test_ニュースレターは下書きまで_送らない(monkeypatch):
    monkeypatch.setattr(newsletter, "draft_issue", lambda subject, body="", topic="": {
        "id": "i1", "subject": subject, "body": "秋の新商品です。", "status": "draft"})
    monkeypatch.setattr(newsletter, "send_issue", lambda *a, **k: pytest.fail("送ってはいけない"),
                        raising=False)
    out, made = _run("newsletter_draft", {"subject": "9月号", "topic": "秋の新商品"})
    assert "下書きを作りました" in out and "送っていません" in out
    assert made[0]["content"] == "秋の新商品です。"
