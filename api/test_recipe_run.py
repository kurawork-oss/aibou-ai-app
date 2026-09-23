"""
保存した手順を流す（tools.recipe_run）までの道を見張る。

ここで守りたいこと
------------------
1. 手元で流すときは**専用ブラウザを持つ、新しい相棒の台**だけ。古い相棒の
   台しか無いのに、ログイン無しのサーバーへ黙って回さない
2. 重さは中身と場所で決まる（押す手があれば、手元では段階3）
3. 確認カードには**流す手順そのもの**が出る（名前だけで承認させない）
4. 承認してから流すまでに重くなっていたら流さない（大改造Aの縛り）
5. 止まったら、何手目で止めて、何を押していないかを言う
"""

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent_local"))

import localagent
import recipes
import risk
import tools
import toolschema
from main import app

client = TestClient(app)

SITE = "intra.example.co.jp"
STEPS = [{"do": "fill", "target": "検索", "value": "{顧客名}"},
         {"do": "click", "target": "検索する"}]


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    localagent.reset()
    recipes._mem._by_tenant.clear()
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    yield
    localagent.reset()
    recipes._mem._by_tenant.clear()


def _device(name="ノート", jobs=True, engines=("playwright",)):
    """その台を「動いている」状態にする。jobs=False は古い相棒。"""
    got = localagent.pair("local", name)
    localagent.take("local", got["device"], wait=0.01)
    localagent.note_engines("local", got["device"], list(engines))
    localagent.note_sites("local", got["device"], [SITE])
    if jobs:
        localagent.note_jobs("local", got["device"], list(localagent.JOBS))
    return got["device"]


@pytest.fixture
def jobs(monkeypatch):
    sent = []

    def _local(kind, params, timeout=60.0, device=""):
        sent.append({"kind": kind, "params": params, "device": device})
        return {"ok": True, "title": "案件一覧", "url": params.get("url", ""),
                "text": "3件", "did": ["「検索」に入力しました", "「検索する」を押しました"],
                "device_name": "ノート", "engine_label": "専用ブラウザ（Playwright）"}

    monkeypatch.setattr(tools, "_local", _local)
    return sent


def _save(steps=None, name="朝のケース確認"):
    got = recipes.save(name, f"https://{SITE}/cases", STEPS if steps is None else steps)
    assert got["ok"], got
    return got["recipe"]


# ── 流す ────────────────────────────────────────────────────────────

def test_it_runs_on_your_device_with_the_values_filled_in(jobs):
    _save()
    _device()
    with risk.ceiling(3):
        out = tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                                "values": {"顧客名": "山田商事"}})
    assert "最後まで流しました" in out
    assert [j["kind"] for j in jobs] == ["recipe"]
    assert jobs[0]["params"]["steps"][0]["value"] == "山田商事"
    assert "専用ブラウザ" in out


def test_values_may_come_as_a_json_string(jobs):
    """AIは JSON の文字列で渡してくることがある（宣言を文字列にしてあるため）。"""
    _save()
    _device()
    with risk.ceiling(3):
        tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                          "values": json.dumps({"顧客名": "佐藤"})})
    assert jobs[0]["params"]["steps"][0]["value"] == "佐藤"


def test_missing_values_are_asked_for_not_guessed(jobs):
    _save()
    _device()
    out = tools.execute_tool("recipe_run", {"name": "朝のケース確認"})
    assert "顧客名" in out and jobs == []


def test_an_unknown_name_lists_what_there_is(jobs):
    _save()
    out = tools.execute_tool("recipe_run", {"name": "夜の片付け"})
    assert "ありません" in out and "朝のケース確認" in out
    assert jobs == []


def test_an_old_agent_is_named_instead_of_falling_back_to_the_server(jobs, monkeypatch):
    """古い相棒の台しか無い。サーバーへ回すと、ログインの要るサイトを
    ログイン無しで流すことになる。回さずに「新しくして」と言う。"""
    _save()
    _device(jobs=False)
    import browser
    monkeypatch.setattr(browser, "available", lambda: True)
    out = tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                            "values": {"顧客名": "x"}})
    assert "古い" in out and "aibou_local.py" in out
    assert jobs == []


def test_a_device_without_the_dedicated_browser_cannot_run_it(jobs):
    """OpenCLI（あなたのChrome）しか無い台では流さない。手順は専用ブラウザの役割。"""
    _save()
    _device(engines=("opencli",))
    out = tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                            "values": {"顧客名": "x"}})
    assert "流せません" in out and jobs == []


def test_a_stopped_run_says_where_and_what_was_not_pressed(monkeypatch):
    _save()
    _device()
    monkeypatch.setattr(tools, "_local", lambda *a, **k: {
        "ok": False, "stopped_at": 2, "did": ["「検索」に入力しました"],
        "error": "2手目で止めました（できませんでした（TimeoutError））。続きは押していません"})
    with risk.ceiling(3):
        out = tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                                "values": {"顧客名": "x"}})
    assert "流しきれませんでした" in out and "2手目" in out and "続きは押していません" in out
    assert recipes.get("朝のケース確認")["last_result"].startswith("✗")


def test_an_agent_that_does_not_know_recipes_is_explained(monkeypatch):
    """知らせてこない相棒に万一届いたとき（知りません）も、分かる言葉で返す。"""
    _save()
    _device()
    monkeypatch.setattr(tools, "_local", lambda *a, **k: {
        "ok": False, "error": "「recipe」は知りません"})
    with risk.ceiling(3):
        out = tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                                "values": {"顧客名": "x"}})
    assert "古く" in out and "aibou_local.py" in out


# ── 重さ ────────────────────────────────────────────────────────────

def test_a_recipe_that_presses_is_the_heaviest_on_your_device():
    _save()
    _device()
    p = {"name": "朝のケース確認"}
    assert risk.level("recipe_run", p) == 3
    assert risk.needs_confirmation("recipe_run", False, params=p) is True
    assert risk.may_always_allow("recipe_run", params=p) is False


def test_a_reading_only_recipe_is_lighter():
    _save(steps=[{"do": "wait", "value": "500"}], name="一覧を見る")
    _device()
    assert risk.level("recipe_run", {"name": "一覧を見る"}) == 2


def test_nothing_to_run_is_not_asked():
    """無い手順・流せる場所が無い。何も起きないので、確認より先に理由を返す。"""
    assert risk.level("recipe_run", {"name": "無い手順"}) == 0
    _save()
    assert risk.level("recipe_run", {"name": "朝のケース確認"}) == 0


def test_a_device_that_connects_after_measuring_is_not_used(jobs):
    """測ったときは流せる場所が無く（0）、流す直前に台がつながった。"""
    _save()
    lv = risk.level("recipe_run", {"name": "朝のケース確認"})
    assert lv == 0
    _device()
    with risk.ceiling(lv):
        out = tools.execute_tool("recipe_run", {"name": "朝のケース確認",
                                                "values": {"顧客名": "x"}})
    assert out == risk.OVER_CEILING and jobs == []


def test_after_reading_a_page_saving_and_running_are_asked():
    """ページに唆されて、いつもの名前で中身を差し替える・流す、を止める。"""
    for tool in ("recipe_save", "recipe_run"):
        assert tool in risk.CHAIN_AFTER_EXTERNAL
        assert risk.needs_confirmation(tool, False, external_reads=1,
                                       params={"name": "x"}) is True


# ── 確認カードに、流す手順そのものが出る ─────────────────────────────

def test_the_card_shows_the_steps_not_just_the_name():
    _save()
    _device()
    info = risk.describe("recipe_run", params={"name": "朝のケース確認",
                                               "values": {"顧客名": "山田商事"}})
    assert "「検索」に「山田商事」と入力" in info["detail"]
    assert "「検索する」を押す" in info["detail"]
    assert f"https://{SITE}/cases" in info["detail"]


def test_other_tools_have_no_detail():
    assert risk.describe("send_email")["detail"] == ""


def test_the_chat_card_carries_the_steps(monkeypatch):
    import main
    _save()
    _device()
    monkeypatch.setattr(main.llm, "active_provider", lambda: "gemini")
    monkeypatch.setattr(main, "mem_recall", lambda *_a, **_k: "")
    monkeypatch.setattr(main, "mem_add", lambda *_a, **_k: None)
    call = tools.TOOL_CALL_MARKER + json.dumps(
        {"tool": "recipe_run", "params": {"name": "朝のケース確認",
                                          "values": {"顧客名": "山田商事"}}},
        ensure_ascii=False)
    monkeypatch.setattr(main.llm, "stream_text", lambda *_a, **_k: iter([call]))
    body = client.post("/chat", json={"message": "朝のケース確認を流して"}).text
    cards = [json.loads(b.strip()[5:]) for b in body.split("\n\n") if b.strip().startswith("data:")]
    card = [c["approval"] for c in cards if "approval" in c][0]
    assert card["level"] == 3 and "山田商事" in card["detail"]


# ── 形 ──────────────────────────────────────────────────────────────

def test_values_are_declared_as_a_json_string():
    d = toolschema.declaration("recipe_run", "説明")
    assert d["parameters"]["properties"]["values"]["type"] == "string"
    fixed, err = toolschema.validate("recipe_run", {"name": "x", "values": {"a": 1}})
    assert not err and fixed["values"] == {"a": "1"}
    fixed, err = toolschema.validate("recipe_run", {"name": "x", "values": '{"a": "b"}'})
    assert not err and fixed["values"] == {"a": "b"}
    _fixed, err = toolschema.validate("recipe_run", {"name": "x", "values": "a=b"})
    assert err


def test_saving_through_the_ai_says_when_it_will_not_last():
    out = tools.execute_tool("recipe_save", {"name": "朝のケース確認",
                                             "url": f"https://{SITE}/cases",
                                             "steps": STEPS})
    assert "保存しました" in out and "再起動すると消えます" in out


def test_saving_a_password_step_through_the_ai_is_refused():
    out = tools.execute_tool("recipe_save", {
        "name": "ログイン", "url": f"https://{SITE}/login",
        "steps": [{"do": "fill", "target": "パスワード", "value": "hunter2hunter2"}]})
    assert "保存できませんでした" in out and recipes.list_all() == []


def test_list_and_delete_through_the_ai():
    _save()
    assert "朝のケース確認" in tools.execute_tool("recipe_list", {})
    assert "消しました" in tools.execute_tool("recipe_delete", {"name": "朝のケース確認"})
    assert "まだありません" in tools.execute_tool("recipe_list", {})


# ── 画面の口 ─────────────────────────────────────────────────────────

def test_the_screen_can_list_save_and_delete_but_not_run():
    """流す口は作らない。流すのは確認の門を通る道だけ。"""
    r = client.post("/recipes", json={"name": "朝のケース確認",
                                      "url": f"https://{SITE}/cases", "steps": STEPS})
    assert r.status_code == 200 and r.json()["ok"] is True
    items = client.get("/recipes").json()["items"]
    assert items[0]["name"] == "朝のケース確認" and items[0]["touches"] is True
    rid = items[0]["id"]
    assert client.delete(f"/recipes/{rid}").json()["ok"] is True
    assert client.get("/recipes").json()["items"] == []

    from main import app as _app
    paths = {getattr(route, "path", "") for route in _app.routes}
    assert not any(p.startswith("/recipes") and "run" in p for p in paths)


def test_the_screen_is_told_why_a_save_was_refused():
    r = client.post("/recipes", json={"name": "ログイン", "url": f"https://{SITE}/",
                                      "steps": [{"do": "fill", "target": "Password",
                                                 "value": "x"}]})
    assert r.status_code == 400 and "鍵" in r.json()["error"]


# ── 手元の相棒と、同じ顔ぶれ ────────────────────────────────────────

def test_the_local_agent_knows_the_same_jobs():
    import aibou_local
    assert set(aibou_local.JOBS) == set(localagent.JOBS)


def test_the_local_agent_refuses_the_same_password_fields():
    """手元の相棒（別のプログラム）とサーバーで、鍵の欄の見分け方を揃える。"""
    import engines
    assert engines.SECRET_FIELD.pattern == recipes._SECRET_FIELD.pattern
