"""
どのAIに頼むかを、仕事の中身で選ぶ（仕様§15・§16・§17・§18）。

なぜ要るか
----------
これまで使えたのは Gemini / HuggingFace / OpenAI の3つで、選び方は
「設定した順」だけだった。仕事の中身は見ていない。

  ・こみ入ったコードの直し   → 得意なモデルがある
  ・人に見せたくない文章     → 手元（Ollama）で済ませたい
  ・ふつうの会話             → 無料枠で足りる

いちばん大事な線引き
--------------------
**勝手に課金しない。** 鍵を入れただけの従量課金サービスを、こちらの判断で
使い始めてはいけない。請求は利用者に行く。だから

  ・無料で使える物（Gemini無料枠・HuggingFace・手元のOllama）は自動で選ぶ
  ・お金がかかる物（Claude・GPT・Grok）は、**その仕事に指名されたときだけ**

という形にする。全部落ちたときの最後の受け皿にだけは入れる——黙って
止まるより、断りを出せるほうがよい。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import router


@pytest.fixture
def keys(monkeypatch):
    """入っている鍵を差し替える。既定は「何も無い」。"""
    store = {}
    monkeypatch.setattr(router, "_key", lambda name: store.get(name, ""))
    return store


# ── 無料優先 ────────────────────────────────────────────────────────

def test_鍵を入れただけでは_課金される方を選ばない(keys):
    """ここが崩れると、利用者の知らないところで請求が立つ。"""
    keys["GEMINI_API_KEY"] = "g"
    keys["ANTHROPIC_API_KEY"] = "a"
    keys["OPENAI_API_KEY"] = "o"
    keys["XAI_API_KEY"] = "x"
    assert router.pick("chat") == "gemini"
    assert router.pick("code") == "gemini"


def test_名指しされたときだけ_課金される方を使う(keys):
    keys["GEMINI_API_KEY"] = "g"
    keys["ANTHROPIC_API_KEY"] = "a"
    keys["ROUTE_CODE"] = "anthropic"
    assert router.pick("code") == "anthropic"
    # 名指ししていない仕事は、そのまま無料側
    assert router.pick("chat") == "gemini"


def test_名指ししても_鍵が無ければ落ちない(keys):
    keys["GEMINI_API_KEY"] = "g"
    keys["ROUTE_CODE"] = "anthropic"          # 鍵は入れていない
    assert router.pick("code") == "gemini"


def test_手元のOllamaは_無料なので自動で選んでよい(keys):
    """自分のパソコンで動いているので、請求も外への送信も起きない。"""
    keys["OLLAMA_URL"] = "http://127.0.0.1:11434"
    keys["GEMINI_API_KEY"] = "g"
    assert router.pick("private") == "ollama"
    # ただし、ふつうの会話まで手元に寄せない（遅いことが多い）
    assert router.pick("chat") == "gemini"


def test_人に見せたくない仕事は_手元が無ければ_手元扱いにしない(keys):
    """Ollamaが無いのに『手元で処理しました』と振る舞ってはいけない。"""
    keys["GEMINI_API_KEY"] = "g"
    assert router.pick("private") == "gemini"


def test_何も無ければ_noneと言う(keys):
    assert router.pick("chat") == "none"


def test_知らない仕事の名前でも落ちない(keys):
    keys["GEMINI_API_KEY"] = "g"
    assert router.pick("とつぜんの新種") == "gemini"


# ── 並び（落ちたときの受け皿） ────────────────────────────────────

def test_選んだ物が先頭に来て_残りが控えになる(keys):
    keys["GEMINI_API_KEY"] = "g"
    keys["HUGGINGFACE_TOKEN"] = "h"
    keys["ANTHROPIC_API_KEY"] = "a"
    keys["ROUTE_CODE"] = "anthropic"
    order = router.order_for("code")
    assert order[0] == "anthropic"
    assert "gemini" in order and "huggingface" in order


def test_控えにも_無料の方が先に来る(keys):
    keys["GEMINI_API_KEY"] = "g"
    keys["OPENAI_API_KEY"] = "o"
    keys["HUGGINGFACE_TOKEN"] = "h"
    order = router.order_for("chat")
    assert order.index("gemini") < order.index("openai")
    assert order.index("huggingface") < order.index("openai")


def test_同じ物が二度並ばない(keys):
    keys["GEMINI_API_KEY"] = "g"
    keys["ROUTE_CHAT"] = "gemini"
    order = router.order_for("chat")
    assert len(order) == len(set(order))


# ── 台帳 ────────────────────────────────────────────────────────────

def test_仕様に挙がっている提供元が_全部ある():
    for want in ("gemini", "anthropic", "openai", "grok", "ollama"):
        assert want in router.PROVIDERS, f"{want} が無い"


def test_どの提供元にも_課金するかどうかが書いてある():
    """ここが抜けると『無料だと思って選ぶ』が起きる。"""
    for name, p in router.PROVIDERS.items():
        assert isinstance(p.get("paid"), bool), f"{name} に課金の有無が無い"
        assert p.get("label"), f"{name} に名前が無い"
        assert p.get("key"), f"{name} に鍵の名前が無い"


def test_鍵そのものを外へ出さない(keys):
    """一覧は画面へ出る。ここに鍵が混ざると、そのまま表示される。"""
    secret = "sk-ant-TOPSECRET-0123456789"
    keys["ANTHROPIC_API_KEY"] = secret
    for row in router.status():
        assert secret not in repr(row), f"{row} に鍵が乗っている"


def test_一覧には_使えるかどうかが出る(keys):
    keys["GEMINI_API_KEY"] = "g"
    rows = {r["id"]: r for r in router.status()}
    assert rows["gemini"]["ready"] is True
    assert rows["anthropic"]["ready"] is False
    assert rows["anthropic"]["paid"] is True
    assert rows["ollama"]["paid"] is False
