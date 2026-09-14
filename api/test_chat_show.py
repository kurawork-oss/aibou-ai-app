"""
会話で何かを作ったとき、作った物がその場に出るか。

なぜここを見張るのか
--------------------
道具が作った物を画面へ渡す口（present.py）は、**実行（司令塔）モードにしか
繋がっていなかった**。ふだん使う会話（/chat）は道具を実行するのに
`present.begin()` を開けておらず、`show()` は黙って捨てる作りになっている。

    present.show(...)  →  箱が開いていない  →  return（何も起きない）

結果、会話で画像を作らせると、出来た画像は捨てられ、本文に

    「画像を生成しました：https://…（HOMEの『生成物』からも見られます）」

とだけ残る。作っておいて住所を渡すのは、渡していないのと同じ。
しかも捨てているので画面には何の手がかりも出ず、不具合として報告されない。

作っている最中も同じ問題がある。道具が10秒かかっても、会話の画面は
「……」のまま止まって見える。何をしているのかを出す。
"""

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main
import present
import tools
from main import app

client = TestClient(app)


def fake_stream(*chunks):
    """llm.stream_text の代わり。区切って返すと、途中判定も通せる。"""
    def _stream(_prompt, **_kw):
        for c in chunks:
            yield c
    return _stream


def events(body: str):
    """SSE の本文を dict の並びに戻す。"""
    out = []
    for block in body.split("\n\n"):
        line = block.strip()
        if not line.startswith("data:"):
            continue
        out.append(json.loads(line[len("data:"):].strip()))
    return out


@pytest.fixture
def talking(monkeypatch):
    """AIが喋れる状態にする（鍵が無くても /chat が動くように）。"""
    monkeypatch.setattr(main.llm, "active_provider", lambda: "gemini")
    # 記憶は別の話。ここでは出さない。
    monkeypatch.setattr(main, "mem_recall", lambda *_a, **_k: "")
    monkeypatch.setattr(main, "mem_add", lambda *_a, **_k: None)


CALL = tools.TOOL_CALL_MARKER + '{"tool":"generate_image","params":{"prompt":"猫"}}'


def test_会話で作った画像が_その場に出る(monkeypatch, talking):
    """いちばん効く所。ここが空だと、作った物は毎回捨てられている。"""
    made = {"kind": "image", "url": "https://example.com/cat.png", "title": "猫"}

    def _exec(_tool, _params):
        present.show(made)          # 道具はいつもこう置く（tools.py の _present）
        return "画像を生成しました：https://example.com/cat.png"

    monkeypatch.setattr(main.tools, "execute_tool", _exec)
    monkeypatch.setattr(main.llm, "stream_text",
                        fake_stream(CALL, "", "できました。"))

    evs = events(client.post("/chat", json={"message": "猫の画像を作って"}).text)
    shown = [e["show"] for e in evs if "show" in e]
    assert shown, f"作った物が流れてきていない: {evs}"
    assert shown[0] == made


def test_道具を使い始めたことが_すぐ分かる(monkeypatch, talking):
    """画像生成は10秒かかることがある。その間ずっと無言だと、
    止まっているのか動いているのか区別が付かない。"""
    monkeypatch.setattr(main.tools, "execute_tool", lambda *_a: "できました")
    monkeypatch.setattr(main.llm, "stream_text", fake_stream(CALL, "はい。"))

    evs = events(client.post("/chat", json={"message": "猫の画像を作って"}).text)
    told = [e for e in evs if e.get("tool")]
    assert told, f"何をしているのか出ていない: {evs}"
    assert told[0]["tool"] == "generate_image"


def test_作った物は_道具の結果より前に出す(monkeypatch, talking):
    """報告の文章より先に物が出ないと、『どこで見るの』と探すことになる。"""
    def _exec(_tool, _params):
        present.show({"kind": "image", "url": "https://example.com/a.png"})
        return "できました"

    monkeypatch.setattr(main.tools, "execute_tool", _exec)
    monkeypatch.setattr(main.llm, "stream_text", fake_stream(CALL, "猫の絵です。"))

    evs = events(client.post("/chat", json={"message": "猫の画像を作って"}).text)
    at_show = next(i for i, e in enumerate(evs) if "show" in e)
    at_token = next((i for i, e in enumerate(evs) if "token" in e), len(evs))
    assert at_show < at_token, "報告の文章が先に出ている"


def test_ふつうの会話では_何も出さない(monkeypatch, talking):
    """出来事の報告に物を付けない。何でも出すと肝心の物が埋もれる。"""
    monkeypatch.setattr(main.llm, "stream_text", fake_stream("こんにちは。"))
    evs = events(client.post("/chat", json={"message": "やあ"}).text)
    assert not [e for e in evs if "show" in e or e.get("tool")]


def test_人が混ざらない(monkeypatch, talking):
    """置き場はリクエストごとに開ける。開けっぱなしだと、Aさんが作った
    画像がBさんの画面に出る。2回続けて呼んで、持ち越さないことを見る。"""
    seen = []

    def _exec(_tool, params):
        present.show({"kind": "image", "url": f"https://example.com/{params['prompt']}.png"})
        return "できました"

    monkeypatch.setattr(main.tools, "execute_tool", _exec)

    for who in ("a", "b"):
        call = tools.TOOL_CALL_MARKER + '{"tool":"generate_image","params":{"prompt":"%s"}}' % who
        monkeypatch.setattr(main.llm, "stream_text", fake_stream(call, "はい"))
        evs = events(client.post("/chat", json={"message": f"{who}の画像を作って"}).text)
        seen.append([e["show"]["url"] for e in evs if "show" in e])

    assert seen == [["https://example.com/a.png"], ["https://example.com/b.png"]], \
        f"前の人の物が残っている: {seen}"


def test_箱は必ず閉じる(monkeypatch, talking):
    """道具が落ちても閉じる。開けっぱなしにすると次の人に漏れる。"""
    def _boom(*_a):
        present.show({"kind": "image", "url": "https://example.com/x.png"})
        raise RuntimeError("道具が落ちた")

    monkeypatch.setattr(main.tools, "execute_tool", _boom)
    monkeypatch.setattr(main.llm, "stream_text", fake_stream(CALL, "はい"))
    client.post("/chat", json={"message": "画像を作って"})

    assert present.peek() == [], "リクエストの外に置き場が残っている"


def test_知らない種類は_画面に渡さない(monkeypatch, talking):
    """画面が描けない物を渡しても、空の枠が出るだけ。present 側で弾く。"""
    def _exec(*_a):
        present.show({"kind": "とつぜんの新種", "url": "x"})
        return "できました"

    monkeypatch.setattr(main.tools, "execute_tool", _exec)
    monkeypatch.setattr(main.llm, "stream_text", fake_stream(CALL, "はい"))
    evs = events(client.post("/chat", json={"message": "画像を作って"}).text)
    assert not [e for e in evs if "show" in e]
