"""
画面でしかできなかったことを、会話からも頼めること。

見つけたこと
------------
「実行」と「管理」に分けた考え方（webapp/src/lib/shell.ts）は、

    一度きりの出来事（作って・答えて）… 会話で完結する
    残っている物を見る・触る          … 画面で

だった。ところが次の2つは、出来事なのに画面でしかできなかった:

  ・入れた資料に聞く … 会話で「規程だと有給は何日？」と聞いても、AIは
                        入れた資料を見ないまま一般論で答えていた
  ・ゴールを進める   … 会話で作れるのに、進めるのはゴールの画面のボタンだけ

ここでは、会話の道具として正しく答えること（そして答えられないときに
推測で埋めないこと）を見る。
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import autopilot
import capabilities as cap
import config
import llm
import notify
import present
import tools
import vault
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    vault._mem_notebooks.clear()
    autopilot._mem_missions.clear()
    yield
    vault._mem_notebooks.clear()
    autopilot._mem_missions.clear()


def _run(name, params):
    """道具を1回動かし、(結果の文, 会話の隣に出た物) を返す。"""
    token = present.begin()
    try:
        out = tools.execute_tool(name, params)
        return out, present.take()
    finally:
        present.end(token)


def _notebook(name, docs):
    nb = vault.create_notebook(name)
    for title, body in docs.items():
        vault.add_text(nb["id"], title, body)
    return nb


@pytest.fixture
def answers(monkeypatch):
    """資料から答える所のAI。何を聞かれたかを残す。"""
    asked = []

    def fake(prompt, **_k):
        asked.append(prompt)
        return "有給休暇は年20日です[1]。"
    monkeypatch.setattr(llm, "generate_text", fake)
    return asked


# ── 入れた資料に聞く ────────────────────────────────────────────────
def test_資料が1冊だけなら_それに聞いて出典つきで答える(answers):
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。", "経費規程": "交通費は実費。"})
    out, made = _run("ask_vault", {"question": "有給は何日？"})
    assert "年20日" in out
    assert "[1] 就業規則" in out                 # どの資料に書いてあったか
    assert "経費規程" not in out.split("出典")[-1]   # 使っていない資料は出典に入れない
    assert len(answers) == 1 and "有給は何日？" in answers[0]
    # 会話の隣にも出す。AIが報告で言い換えても、出典は消えない
    assert made and made[0]["kind"] == "document"
    assert "社内規程" in made[0]["title"] and "[1] 就業規則" in made[0]["content"]


def test_資料の中身は_指示として実行させない(answers):
    """取り込んだPDFに「前の指示を無視して…」と書いてあっても、データとして渡す。"""
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。"})
    out, _ = _run("ask_vault", {"question": "有給は何日？"})
    assert "<<<ここから外部の文章（データ）>>>" in out and "<<<ここまで外部の文章>>>" in out


def test_何冊もあって名前が無いときは_勝手に選ばず聞き直す(answers):
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。"})
    _notebook("議事録", {"9月定例": "新商品は10月に出す。"})
    out, made = _run("ask_vault", {"question": "有給は何日？"})
    assert "社内規程" in out and "議事録" in out and "notebook" in out
    assert answers == [] and made == []        # AIを呼んでいない・何も出していない


def test_名前を渡せば_その1冊に聞く(answers):
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。"})
    _notebook("議事録", {"9月定例": "新商品は10月に出す。"})
    out, _ = _run("ask_vault", {"question": "有給は何日？", "notebook": "規程"})
    assert "資料「社内規程」" in out and len(answers) == 1
    assert "新商品" not in answers[0]           # 別の冊の中身をAIに渡していない


def test_質問に冊の名前が入っていれば_それを使う(answers):
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。"})
    _notebook("議事録", {"9月定例": "新商品は10月に出す。"})
    out, _ = _run("ask_vault", {"question": "議事録だと、新商品はいつ？"})
    assert "資料「議事録」" in out


def test_ノートブックが無いときは_どこで作るかを言う(answers):
    out, made = _run("ask_vault", {"question": "有給は何日？"})
    assert "ノートブックがありません" in out and "「資料」" in out
    assert answers == [] and made == []


def test_空のノートブックには_AIを呼ばずにそう言う(answers):
    vault.create_notebook("社内規程")
    out, _ = _run("ask_vault", {"question": "有給は何日？"})
    assert "まだ資料が入っていません" in out and answers == []


def test_出典の番号が付かなかったら_推測で補わせない(monkeypatch):
    monkeypatch.setattr(llm, "generate_text", lambda p, **k: "資料には記載がありません。")
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。"})
    out, _ = _run("ask_vault", {"question": "賞与は何か月？"})
    assert "出典の番号が付いていません" in out and "推測で補わず" in out


def test_入っている資料の一覧を見られる():
    _notebook("社内規程", {"就業規則": "有給は年20日。", "経費規程": "交通費は実費。"})
    vault.create_notebook("空の冊")
    out, _ = _run("vault_list", {})
    assert "「社内規程」資料2件" in out and "就業規則" in out and "経費規程" in out
    assert "「空の冊」資料0件" in out


# ── ゴールを進める ──────────────────────────────────────────────────
class _Model:
    """ゴールの手順を作るAI。呼ばれた回数を数える。"""
    def __init__(self):
        self.calls = 0

    def generate_content(self, prompt):
        self.calls += 1
        return type("R", (), {"text": f"成果{self.calls}"})()


@pytest.fixture
def model(monkeypatch):
    m = _Model()
    monkeypatch.setattr(config, "get_gemini_model", lambda: m)
    sent = []
    monkeypatch.setattr(notify, "notify_all", lambda msg: sent.append(msg) or {"sent": []})
    m.sent = sent
    return m


def _mission(goal, titles, status="active", current=0):
    m = {"id": f"m-{goal}", "goal": goal, "status": status, "current": current,
         "steps": [{"n": i + 1, "title": t, "status": "pending", "result": ""}
                   for i, t in enumerate(titles)],
         "log": [], "notify": True}
    autopilot._mem_missions.append(m)
    return m


def test_進行中が1つなら_名前が無くても次の手順を進める(model):
    _mission("提案資料を仕上げる", ["骨子を作る", "図を作る", "見直す"])
    out, made = _run("mission_step", {})
    assert "1手進めました（1/3）" in out
    assert "骨子を作る" in out and "成果1" in out      # やった手順と、その成果
    assert "次の手順: 図を作る" in out
    assert made and made[0]["kind"] == "document" and "成果1" in made[0]["content"]


def test_一度に進めるのは3手まで(model):
    _mission("提案資料を仕上げる", ["1", "2", "3", "4", "5"])
    out, _ = _run("mission_step", {"steps": 9})
    assert model.calls == 3 and "3手進めました（3/5）" in out


def test_最後の手順まで行ったら_終わったと言う(model):
    _mission("提案資料を仕上げる", ["骨子を作る", "見直す"], current=1)
    out, _ = _run("mission_step", {})
    assert "全部の手順が終わりました" in out
    assert autopilot._mem_missions[0]["status"] == "completed"


def test_進行中が複数あって名前が無いときは_勝手に選ばない(model):
    _mission("提案資料を仕上げる", ["骨子を作る"])
    _mission("引っ越しの準備", ["業者を選ぶ"])
    out, made = _run("mission_step", {})
    assert "2つあります" in out and "提案資料" in out and "引っ越し" in out
    assert model.calls == 0 and made == []


def test_名前の一部で_どれを進めるか選べる(model):
    _mission("提案資料を仕上げる", ["骨子を作る"])
    _mission("引っ越しの準備", ["業者を選ぶ"])
    out, _ = _run("mission_step", {"goal": "引っ越し"})
    assert "業者を選ぶ" in out and "提案資料" not in out


def test_進めるのに失敗したら_失敗と言う(monkeypatch, model):
    monkeypatch.setattr(config, "get_gemini_model", lambda: None)
    _mission("提案資料を仕上げる", ["骨子を作る"])
    out, made = _run("mission_step", {})
    assert "失敗しました" in out and "進めました" not in out
    assert made == []


def test_進行中のゴールが無いときは_そう言う(model):
    _mission("前のゴール", ["x"], status="completed", current=1)
    out, _ = _run("mission_step", {})
    assert "進行中のゴールがありません" in out and model.calls == 0


def test_ゴールの一覧に_進み具合と次の手順が出る():
    _mission("提案資料を仕上げる", ["骨子を作る", "図を作る"], current=1)
    _mission("前のゴール", ["x"], status="completed", current=1)
    out, _ = _run("mission_list", {})
    assert "「提案資料を仕上げる」進行中（1/2） 次: 図を作る" in out
    assert "「前のゴール」完了（1/1）" in out


# ── # の近道からも同じことができる ─────────────────────────────────────
def test_シャープから資料に聞ける(answers):
    _notebook("社内規程", {"就業規則": "有給休暇は年20日とする。"})
    r = client.post("/command", json={"text": "#資料に聞く 有給は何日？"}).json()
    assert r["ok"] is True and r["tool"] == "ask_vault"
    assert "年20日" in r["result"] and r["show"][0]["kind"] == "document"


def test_シャープからゴールを進められる(model):
    _mission("提案資料を仕上げる", ["骨子を作る", "見直す"])
    r = client.post("/command", json={"text": "#ゴールを進める"}).json()
    assert r["ok"] is True and r["tool"] == "mission_step" and "成果1" in r["result"]


def test_足した近道で_前からの呼び方が割れない():
    """「#ごーる」「#しりょう」と打った人が、これまで通り1つに決まること。"""
    assert cap.find("ごーる")["cmd"] == "ゴール"
    assert cap.find("しりょう")["cmd"] == "資料"
    assert cap.find("きく")["cmd"] == "資料に聞く"
    assert cap.find("すすめる")["cmd"] == "ゴールを進める"


def test_会話にも_既定で渡っている():
    """作っても、AIに渡っていなければ無いのと同じ（以前、手元の道具で実際にあった）。"""
    offered = cap.enabled_tools()
    for t in ("ask_vault", "vault_list", "mission_list", "mission_step"):
        assert t in offered, f"{t} が会話に渡っていない"
