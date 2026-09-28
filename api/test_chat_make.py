"""
「つくる」「SNS」の画面でしか作れなかった物を、会話から頼めること。

SNSの投稿文・LP・Webアプリ・動画の絵コンテは、どれも一度きりの頼み事
（shell.ts の線引きでは会話の側）なのに、画面の中にしか入口が無かった。
会話で「カフェのホームページ作って」と頼むと、AIには道具が無く、
文章で説明するか、別の道具（ドキュメント）で代わりに書いていた。

見ること:
  ・作った物が、会話の隣にそのまま出る（住所だけ伝えない）
  ・SNSは**投稿しない**（案まで。投稿は人が画面で押す）
  ・動画は絵コンテまで（書き出しは重いので、画面で押す）
  ・作れなかったときに、作ったと言わない
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import artifacts
import capabilities as cap
import config
import lp
import present
import risk
import sns
import tools
import video_script
from main import app

client = TestClient(app)

HTML = ("<!DOCTYPE html><html><head><title>森のカフェ</title></head><body>"
        + "<h1>森のカフェ</h1>" + "<p>ようこそ</p>" * 40 + "</body></html>")


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    artifacts._mem_artifacts.clear()
    yield
    artifacts._mem_artifacts.clear()


def _run(name, params):
    token = present.begin()
    try:
        return tools.execute_tool(name, params), present.take()
    finally:
        present.end(token)


# ── LP・Webアプリ ───────────────────────────────────────────────────
@pytest.fixture
def site(monkeypatch):
    asked = []

    def fake(brief, style="modern", sections="", current="", kind="lp"):
        asked.append({"brief": brief, "style": style, "kind": kind})
        return {"ok": True, "html": HTML, "title": "森のカフェ", "kind": kind}
    monkeypatch.setattr(lp, "generate", fake)
    return asked


def test_ホームページを作ると_会話の隣にそのまま出て_ファイルに残る(site):
    out, made = _run("create_lp", {"brief": "森のカフェのホームページ", "style": "warm"})
    assert "ページ「森のカフェ」を作りました" in out and "「ファイル」に残りました" in out
    assert site == [{"brief": "森のカフェのホームページ", "style": "warm", "kind": "lp"}]
    assert made[0]["kind"] == "site" and made[0]["html"] == HTML and made[0]["app"] is False
    saved = artifacts.list_artifacts()
    assert saved[0]["kind"] == "site" and saved[0]["id"] == made[0]["artifact_id"]


def test_Webアプリは_ファイルのアプリ一覧と同じ種類で残る(site):
    """「ファイル」の画面はアプリを kind=webapp で並べている。違う種類で残すと、
    会話で作ったアプリだけ一覧に出ない。"""
    out, made = _run("create_app", {"brief": "家計簿アプリ"})
    assert "Webアプリ「森のカフェ」を作りました" in out and "実際に操作できます" in out
    assert site[0]["kind"] == "app"
    assert made[0]["app"] is True
    assert artifacts.list_artifacts()[0]["kind"] == "webapp"


def test_作れなかったら_作ったと言わない(monkeypatch):
    monkeypatch.setattr(lp, "generate", lambda *a, **k: {"error": "HTMLとして解釈できる出力が得られませんでした"})
    out, made = _run("create_lp", {"brief": "森のカフェ"})
    assert "作れませんでした" in out and "作りました" not in out
    assert made == [] and artifacts.list_artifacts() == []


# ── SNSの投稿文 ─────────────────────────────────────────────────────
@pytest.fixture
def posts(monkeypatch):
    asked = []

    def fake(platform, topic, n=3, tone="", promo=False, thread=False):
        asked.append({"platform": platform, "topic": topic, "n": n, "promo": promo})
        return {"ok": True, "platform": platform, "label": "X (旧Twitter)", "limit": 280,
                "posts": [
                    {"text": "新作のケーキが出ました", "hashtags": ["#PR", "#カフェ"],
                     "length": 20, "over_limit": False},
                    {"text": "長い" * 200, "hashtags": [], "length": 400, "over_limit": True},
                ]}
    monkeypatch.setattr(sns, "generate_posts", fake)
    return asked


def test_投稿文の案を作るが_投稿はしない(posts, monkeypatch):
    import x_client
    monkeypatch.setattr(x_client, "post", lambda *a, **k: pytest.fail("投稿してはいけない"))
    out, made = _run("sns_draft", {"topic": "新作ケーキ", "promo": True})
    assert "案を2つ作りました（投稿はしていません）" in out
    assert posts[0]["promo"] is True and posts[0]["platform"] == "x"
    assert "#PR" in out                          # PR案件の表示を落とさない
    assert "上限280字を超えています" in out     # 超えている案は、超えていると言う
    assert "「SNS」で中身を確かめてから押して" in out
    assert made[0]["kind"] == "document" and "案1" in made[0]["content"]


def test_SNSの案は_既定では会話に渡らない():
    """SNSの画面と同じ「発信する」のかたまり（既定で切ってある）。
    画面の入口が無いのに、会話からだけ作れる、を作らない。"""
    assert "sns_draft" not in cap.enabled_tools()
    assert cap.find("投稿文") is None or cap.find("投稿文")["pack"] == "share"


# ── 動画 ───────────────────────────────────────────────────────────
def test_動画は絵コンテまで作って_書き出しは画面で押す(monkeypatch):
    got = {}

    def fake(topic, n=5, aspect="16:9", tone="friendly", style=""):
        got.update(topic=topic, n=n, aspect=aspect)
        return {"ok": True, "title": "朝のストレッチ", "scenes": [
            {"narration": "おはようございます", "visual": "朝日"},
            {"narration": "肩を回します", "visual": "人が肩を回す"}]}
    monkeypatch.setattr(video_script, "storyboard", fake)
    out, made = _run("create_video", {"topic": "朝のストレッチ", "aspect": "9:16", "n": 2})
    assert got == {"topic": "朝のストレッチ", "n": 2, "aspect": "9:16"}
    assert "2シーン作りました（9:16）" in out and "「動画にする」を押すと" in out
    assert made[0]["kind"] == "video" and made[0]["aspect"] == "9:16"
    assert [s["narration"] for s in made[0]["scenes"]] == ["おはようございます", "肩を回します"]


def test_絵コンテが作れなかったら_そう言う(monkeypatch):
    monkeypatch.setattr(video_script, "storyboard", lambda *a, **k: {"error": "絵コンテを読み取れませんでした"})
    out, made = _run("create_video", {"topic": "朝のストレッチ"})
    assert "作れませんでした" in out and made == []


# ── 共通 ───────────────────────────────────────────────────────────
def test_重さは_作って残すかどうかで決まる():
    assert risk.level("sns_draft") == 0 and risk.level("create_video") == 0   # 見せるだけ
    assert risk.level("create_lp") == 1 and risk.level("create_app") == 1     # 中に残る


def test_つくる物は_既定で会話に渡る():
    offered = cap.enabled_tools()
    for t in ("create_lp", "create_app", "create_video"):
        assert t in offered


def test_シャープからも作れる(site):
    r = client.post("/command", json={"text": "#LP 森のカフェのホームページ"}).json()
    assert r["ok"] is True and r["tool"] == "create_lp" and r["show"][0]["kind"] == "site"
    assert cap.find("えるぴー")["cmd"] == "LP"
    assert cap.find("どうが")["cmd"] == "動画"
    assert cap.find("がぞう")["cmd"] == "画像"           # 前からある物が割れていない


def test_画面に出す種類が_描ける物だけになっている():
    """present.KINDS に無い種類は捨てられ、画面に何も出ない。"""
    for kind in ("site", "video"):
        assert kind in present.KINDS
