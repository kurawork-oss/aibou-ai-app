# test_capabilities.py — メール / カレンダー / Web / 承認ステップ のテスト
# 外部（SMTP/IMAP/Google/Web）へは出ず monkeypatch でモックする。

from fastapi.testclient import TestClient

import agent
import email_svc
import gservice
import llm
import tools
import web
from main import app

client = TestClient(app)


# ── Web 検索 / 読み取り ──────────────────────────────────────────────
def test_web_search_parses(monkeypatch):
    page = ('<a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fp">Ex Title</a>'
            '<a class="result__snippet">a snippet here</a>')

    class FakeResp:
        text = page

    monkeypatch.setattr(web.requests, "post", lambda *a, **k: FakeResp())
    res = web.web_search("test")
    assert res["ok"] is True
    assert res["results"][0]["url"] == "https://example.com/p"
    assert res["results"][0]["title"] == "Ex Title"
    assert "snippet" in res["results"][0]["snippet"]


def test_web_search_empty_query():
    assert web.web_search("")["ok"] is False


def test_web_read_strips_html(monkeypatch):
    page = "<html><head><title>T</title><style>.x{}</style></head><body><script>bad()</script><p>Hello world</p></body></html>"

    class FakeResp:
        text = page

    monkeypatch.setattr(web.requests, "get", lambda *a, **k: FakeResp())
    res = web.web_read("https://x.com")
    assert res["ok"] is True and res["title"] == "T"
    assert "Hello world" in res["text"] and "bad()" not in res["text"]


def test_web_tools_via_dispatch(monkeypatch):
    monkeypatch.setattr(web, "web_search", lambda q, n=5: {"ok": True, "results": [{"title": "A", "url": "u", "snippet": "s"}]})
    r = tools.execute_tool("web_search", {"query": "x"})
    assert "検索結果" in r and "A" in r


# ── メール ───────────────────────────────────────────────────────────
def test_email_send_not_configured(monkeypatch):
    import keychain
    monkeypatch.setattr(keychain, "get_key", lambda name: "")
    r = tools.execute_tool("send_email", {"to": "a@b.com", "subject": "x", "body": "y"})
    assert "未設定" in r


def test_email_send_mocked(monkeypatch):
    monkeypatch.setattr(email_svc, "_addr", lambda: "me@gmail.com")
    monkeypatch.setattr(email_svc, "_password", lambda: "pw")
    sent = {}

    class FakeSMTP:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def login(self, u, p):
            sent["login"] = (u, p)
        def send_message(self, msg):
            sent["to"] = msg["To"]

    monkeypatch.setattr(email_svc.smtplib, "SMTP_SSL", lambda *a, **k: FakeSMTP())
    res = email_svc.send("to@x.com", "Hi", "Body")
    assert res["ok"] is True and sent["login"][0] == "me@gmail.com" and sent["to"] == "to@x.com"


def test_email_send_requires_to():
    assert "宛先" in tools.execute_tool("send_email", {"to": "", "body": "hi"})


# ── カレンダー ───────────────────────────────────────────────────────
def test_calendar_add_not_connected():
    r = tools.execute_tool("calendar_add", {"title": "会議", "date": "2026-07-20"})
    assert "Google" in r and ("未接続" in r or "未設定" in r)


def test_gservice_create_event_mocked(monkeypatch):
    monkeypatch.setattr(gservice, "_access_token", lambda: "tok")

    class FakeResp:
        content = b"{}"
        def __init__(self, d):
            self._d = d
        def json(self):
            return self._d

    monkeypatch.setattr(gservice.requests, "post", lambda *a, **k: FakeResp({"id": "ev1", "htmlLink": "https://cal/ev1"}))
    res = gservice.create_event("会議", "2026-07-20", "15:00")
    assert res["ok"] is True and res["id"] == "ev1"


def test_calendar_add_requires_date():
    assert "日付" in tools.execute_tool("calendar_add", {"title": "x", "date": ""})


# ── 承認ステップ（human-in-the-loop） ────────────────────────────────
def test_agent_approval_pauses_sensitive(monkeypatch):
    monkeypatch.setattr(agent.llm, "generate_text",
                        lambda p, **k: '<<<TOOL_CALL>>>{"tool":"send_email","params":{"to":"a@b.com","subject":"x","body":"y"}}')
    called = []
    monkeypatch.setattr(agent.tools, "execute_tool", lambda name, params: called.append(name) or "sent")

    events = list(agent.run_stream("メール送って", approval=True))
    phases = [e["phase"] for e in events]
    assert "approval" in phases and "tool" not in phases
    assert called == []  # 実行されていない
    ap = next(e for e in events if e["phase"] == "approval")
    assert ap["tool"] == "send_email" and ap["params"]["to"] == "a@b.com"


def test_agent_approval_allows_nonsensitive(monkeypatch):
    seq = iter(['<<<TOOL_CALL>>>{"tool":"list_state","params":{}}', "完了しました"])
    monkeypatch.setattr(agent.llm, "generate_text", lambda p, **k: next(seq))
    monkeypatch.setattr(agent.tools, "execute_tool", lambda n, pa: "状況OK")
    events = list(agent.run_stream("状況教えて", approval=True))
    phases = [e["phase"] for e in events]
    assert "tool" in phases and "approval" not in phases


def test_agent_no_approval_runs_sensitive_inline(monkeypatch):
    seq = iter(['<<<TOOL_CALL>>>{"tool":"notify","params":{"message":"hi"}}', "通知しました"])
    monkeypatch.setattr(agent.llm, "generate_text", lambda p, **k: next(seq))
    ran = []
    monkeypatch.setattr(agent.tools, "execute_tool", lambda n, pa: ran.append(n) or "ok")
    events = list(agent.run_stream("通知して", approval=False))
    phases = [e["phase"] for e in events]
    assert "tool" in phases and "approval" not in phases and "notify" in ran


# ── エンドポイント ───────────────────────────────────────────────────
def test_agent_execute_endpoint(monkeypatch):
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: f"ran {n}")
    r = client.post("/agent/execute", json={"tool": "add_task", "params": {"title": "x"}})
    assert r.status_code == 200 and r.json()["result"] == "ran add_task"


def test_agent_act_approval_streams_approval(monkeypatch):
    monkeypatch.setattr(llm, "active_provider", lambda: "gemini")
    monkeypatch.setattr(llm, "generate_text",
                        lambda p, **k: '<<<TOOL_CALL>>>{"tool":"notify","params":{"message":"hi"}}')
    r = client.post("/agent/act", json={"instruction": "通知して", "approval": True})
    assert r.status_code == 200
    assert '"phase": "approval"' in r.text
