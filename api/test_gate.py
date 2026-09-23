"""
確認の門（仕様§8 Approval Gate）を、道具の入口すべてで見張る。

なぜ足したのか
--------------
1. **ふだんの会話（/chat）が、門を通っていなかった。**
   実行モード（/agent/act）は段階を見て確認カードを出すのに、会話は
   AIが選んだ道具をそのまま実行していた。「上司にメールを送って」で、
   メールが実際に1通飛んだ（試して確かめた）。「段階3は設定に関わらず
   必ず聞く」が、いちばん使う画面で守られていなかった。

2. **測った重さと、動かす重さがずれうる。**
   ブラウザの道具は「どこで開くか」で重さが変わる（手元の台＝あなたとして）。
   確認カードを出してから押されるまでは人の時間が空き、その間に台が
   つながると、「公開ページを読む」と見せて承認された物が「あなたとして
   操作する」に変わる。門を通した重さを実行まで持っていき、それを超えたら
   動かさない（risk.ceiling）。
"""

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent
import approvals
import config
import localagent
import main
import risk
import tools
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    localagent.reset()
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    yield
    localagent.reset()


def _logged_in_site(user="local"):
    """「intra.example.co.jp を許している台が1台動いている」状態を作る。"""
    got = localagent.pair(user, "ノート")
    localagent.take(user, got["device"], wait=0.01)
    localagent.note_engines(user, got["device"], ["playwright"])
    localagent.note_sites(user, got["device"], ["intra.example.co.jp"])
    return got["device"]


ACT = {"url": "https://intra.example.co.jp/cases",
       "steps": [{"do": "click", "target": "送信"}]}


@pytest.fixture
def jobs(monkeypatch):
    """手元の台へ頼んだ仕事を記録する（本物の台は居ないので、待たずに返す）。"""
    sent = []

    def _local(kind, params, timeout=60.0, device=""):
        sent.append({"kind": kind, "params": params, "device": device})
        return {"ok": True, "title": "案件一覧", "url": params.get("url", ""),
                "text": "押しました", "device_name": "ノート"}

    monkeypatch.setattr(tools, "_local", _local)
    return sent


# ── 1. 会話（/chat）も門を通る ────────────────────────────────────────

def _fake_stream(*chunks):
    def _stream(_prompt, **_kw):
        for c in chunks:
            yield c
    return _stream


def _events(body: str):
    out = []
    for block in body.split("\n\n"):
        line = block.strip()
        if line.startswith("data:"):
            out.append(json.loads(line[len("data:"):].strip()))
    return out


@pytest.fixture
def talking(monkeypatch):
    monkeypatch.setattr(main.llm, "active_provider", lambda: "gemini")
    monkeypatch.setattr(main, "mem_recall", lambda *_a, **_k: "")
    monkeypatch.setattr(main, "mem_add", lambda *_a, **_k: None)
    ran = []
    monkeypatch.setattr(main.tools, "execute_tool",
                        lambda name, params: ran.append(name) or "実行しました")
    return ran


def _say(monkeypatch, tool, params, **body):
    call = tools.TOOL_CALL_MARKER + json.dumps({"tool": tool, "params": params},
                                               ensure_ascii=False)
    monkeypatch.setattr(main.llm, "stream_text", _fake_stream(call, "はい。"))
    return _events(client.post("/chat", json={"message": "おねがい", **body}).text)


def test_chat_does_not_send_mail_without_asking(monkeypatch, talking):
    """直した穴そのもの。ここが落ちると、会話で頼んだメールが黙って飛ぶ。"""
    evs = _say(monkeypatch, "send_email",
               {"to": "boss@example.com", "subject": "報告", "body": "終わりました"},
               approval=False, allow=["send_email"])
    asked = [e["approval"] for e in evs if "approval" in e]
    assert asked, f"確認カードが出ていない: {evs}"
    assert talking == [], "確認の前に実行された"
    card = asked[0]
    assert card["tool"] == "send_email" and card["level"] == 3
    assert card["always_confirm"] is True
    assert card["may_always"] is False        # 段階3に「いつも許可」は出さない
    assert card["params"]["to"] == "boss@example.com"   # 何を承認するのか見える
    assert evs[-1] == {"done": True}


def test_chat_still_does_light_things_at_once(monkeypatch, talking):
    """段階0・1は聞かない。ここまで止めると、会話で何も頼めなくなる。"""
    evs = _say(monkeypatch, "add_task", {"title": "牛乳"})
    assert talking == ["add_task"]
    assert not [e for e in evs if "approval" in e]


def test_chat_follows_the_approval_setting_for_outside_changes(monkeypatch, talking):
    """段階2（外に残る）は、実行モードと同じく「確認しながら進める」に従う。"""
    params = {"title": "会議", "date": "2026-10-01"}
    evs = _say(monkeypatch, "calendar_add", params, approval=True)
    assert [e for e in evs if "approval" in e] and talking == []

    evs = _say(monkeypatch, "calendar_add", params, approval=False)
    assert not [e for e in evs if "approval" in e] and talking == ["calendar_add"]

    talking.clear()
    evs = _say(monkeypatch, "calendar_add", params, approval=True, allow=["calendar_add"])
    assert not [e for e in evs if "approval" in e] and talking == ["calendar_add"]


def test_an_old_screen_is_asked(monkeypatch, talking):
    """設定を送ってこない古い画面は「聞く」側に倒す（黙って通す側ではなく）。"""
    evs = _say(monkeypatch, "calendar_add", {"title": "会議", "date": "2026-10-01"})
    assert [e for e in evs if "approval" in e] and talking == []


# ── 2. 動かせない物には確認を出さず、先に理由を返す ─────────────────

def test_nowhere_to_run_is_not_asked_but_explained(jobs):
    """手元の台もサーバーのブラウザも無い。押せないのに「あなたとして押して
    よいか」と聞くと、承認のあとで「場所がありません」と返ることになる。"""
    assert risk.level("browser_act", ACT) == 0
    out = tools.execute_tool("browser_act", ACT)
    assert "操作できる場所がありません" in out
    assert jobs == []


def test_two_devices_ask_which_one_before_anything_else(jobs):
    """2台とも同じサイトを許している。確認より先に「どちらの台か」を聞き返す。

    台が名指しされた呼び直しで、改めて段階3になり、確認が出る。
    """
    for name in ("ノート", "デスクトップ"):
        got = localagent.pair("local", name)
        localagent.take("local", got["device"], wait=0.01)
        localagent.note_engines("local", got["device"], ["opencli"])
        localagent.note_sites("local", got["device"], ["intra.example.co.jp"])
    assert risk.level("browser_act", ACT) == 0
    with risk.ceiling(risk.level("browser_act", ACT)):
        out = tools.execute_tool("browser_act", ACT)
    assert "2台" in out and jobs == []

    named = {**ACT, "device": "ノート"}
    assert risk.level("browser_act", named) == 3
    assert risk.needs_confirmation("browser_act", False, params=named) is True


# ── 3. 通した重さを超えたら動かさない ──────────────────────────────

def test_no_ceiling_means_no_limit():
    """門を通っていない呼び出し（# の近道など）は縛らない。"""
    assert risk.within_ceiling(3) is True
    with risk.ceiling(1):
        assert risk.within_ceiling(1) is True
        assert risk.within_ceiling(2) is False
    assert risk.within_ceiling(3) is True, "縛りが外に漏れている"


def test_a_device_that_connects_in_between_is_not_used(jobs):
    """測ったときは台が無く（段階0で素通し）、動かす直前に台がつながった。

    そのまま動かすと、確認していないのに「あなたとして」押すことになる。
    """
    lv = risk.level("browser_act", ACT)
    assert lv == 0
    _logged_in_site()                       # ← 測ったあとで、台がつながる
    with risk.ceiling(lv):
        out = tools.execute_tool("browser_act", ACT)
    assert out == risk.OVER_CEILING
    assert jobs == [], "確認していない重さで、手元の台に仕事を渡した"


def test_what_was_approved_still_runs(jobs):
    _logged_in_site()
    with risk.ceiling(3):
        out = tools.execute_tool("browser_act", ACT)
    assert "押しました" in out
    assert [j["kind"] for j in jobs] == ["browse_act"]


def test_lighter_than_approved_is_fine(jobs):
    """承認したときは手元の台（段階3）、押された時にはサーバー（段階0）。軽くなる分には動かす。"""
    with risk.ceiling(3):
        out = tools.execute_tool("browser_open", {"url": "https://example.com"})
    assert out != risk.OVER_CEILING


def test_the_approve_button_carries_the_level_it_showed(jobs):
    """確認カード（段階0・連鎖）を出したあと、押されるまでに台がつながった。"""
    _logged_in_site()
    r = client.post("/agent/execute", json={"tool": "browser_act", "params": ACT,
                                            "level": 0})
    assert r.json()["result"] == risk.OVER_CEILING
    assert jobs == []

    r = client.post("/agent/execute", json={"tool": "browser_act", "params": ACT,
                                            "level": 3})
    assert "押しました" in r.json()["result"]
    assert len(jobs) == 1


def test_an_old_approve_button_still_works(jobs):
    """段階を送ってこない古い画面は、これまで通り（縛らない）。"""
    _logged_in_site()
    r = client.post("/agent/execute", json={"tool": "browser_act", "params": ACT})
    assert "押しました" in r.json()["result"]


def test_the_agent_loop_carries_what_it_measured(monkeypatch):
    """実行モードの1手でも、測った重さのまま実行まで持っていく。"""
    seen = []
    decisions = iter([
        {"call": {"tool": "browser_act", "params": ACT}, "text": ""},
        {"call": None, "text": "終わりました"},
    ])
    monkeypatch.setattr(agent.toolcall, "decide", lambda *a, **k: next(decisions))
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    monkeypatch.setattr(tools, "execute_tool",
                        lambda name, params: seen.append(risk._ceiling.get()) or "ok")
    list(agent.run_stream("案件を送って", approval=False))
    assert seen == [0], "測った重さ（場所が無い＝0）が実行まで届いていない"


# ── 4. 通知から答える承認も同じ ─────────────────────────────────────

def test_a_parked_approval_keeps_the_level_it_was_asked_at(monkeypatch):
    got = {}

    def _exec(name, params):
        got.update(params=params, ceiling=risk._ceiling.get(),
                   who=config.current_user_id())
        return "ok"

    monkeypatch.setattr(tools, "execute_tool", _exec)
    row = approvals.create("browser_act", dict(ACT), user_id="u-1", level=0)

    # 画面の一覧には、控えのための印を出さない（段階は別の欄で見せる）
    listed = [r for r in approvals.list_pending() if r["id"] == row["id"]][0]
    assert approvals._LEVEL_KEY not in listed["params"]
    assert listed["level"] == 0

    res = approvals.answer_signed_in(row["id"], "approve")
    assert res["ok"] is True
    assert got["ceiling"] == 0, "止めたときの段階で縛っていない"
    assert approvals._LEVEL_KEY not in got["params"], "控えの印が道具に渡った"
    # 手元の台は「誰の」で引く。DBだけ戻しても、その人の台には届かない
    assert got["who"] == "u-1"
    assert config.current_user_id() == "", "「誰の」が外に漏れている"


def test_a_smuggled_level_is_not_trusted():
    """引数に紛れ込ませた印で、縛りを緩められない。"""
    row = approvals.create("browser_act", {**ACT, approvals._LEVEL_KEY: 3})
    assert approvals._LEVEL_KEY not in row["params"]


def test_the_schedule_round_knows_whose_devices_to_use(monkeypatch):
    """定期実行は人ごとに回る。DBだけでなく「誰の」も差し替えること。"""
    import scheduler
    import tenancy
    seen = []

    def fake_tick(user_id=""):
        seen.append(config.current_user_id())
        return {"ran": [], "count": 0}

    monkeypatch.setattr(scheduler, "tick", fake_tick)
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["u-a", "u-b"])
    monkeypatch.setattr(tenancy, "client_for", lambda uid: object())
    scheduler.tick_everyone()
    assert seen == ["", "u-a", "u-b"]
    assert config.current_user_id() == ""
