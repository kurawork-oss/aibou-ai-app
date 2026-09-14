"""
「いま何ができて、何ができないか、なぜか、何をすればできるか」。

なぜ要るか
----------
このアプリは、できることが30以上ある。そのうちどれが**いま本当に使えるか**は、
鍵・OAuth・保存先・機能のパックが絡み合って決まる。これまでその答えは
どこにも1か所で無く、利用者は押して失敗してから理由を知っていた。

答えられなければいけないのは4つ:

  ・できるか
  ・できないなら、なぜか
  ・何をすればできるようになるか
  ・それは自分でできることか、持ち主に頼むことか

いちばん大事なのは**「使える」と嘘をつかないこと**。押して失敗するより、
先に「繋いでいません」と言うほうがよい。逆に、使えるのに使えないと言うのも
同じくらい悪い（そこで人は諦める）。

ここは status が現実とずれていないかを見る。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import capability_status as cs


# ── 台帳そのもの ────────────────────────────────────────────────────

def test_状態は決めた8つしか使わない():
    """画面が知らない状態を返すと、色も文言も付かずに素通りする。"""
    for cap in cs.snapshot():
        assert cap["status"] in cs.STATUSES, \
            f"{cap['id']} が知らない状態を返した: {cap['status']}"


def test_できない理由と_次の一手が必ず付く():
    """「使えません」だけで終わらせない。理由と次の手が無いと、
    利用者はそこで止まる。"""
    for cap in cs.snapshot():
        if cap["status"] in ("connected", "available"):
            continue
        assert cap.get("why"), f"{cap['id']} に理由が無い"
        assert cap.get("next"), f"{cap['id']} に次の一手が無い"


def test_使える物には_理由を付けない():
    """使えるのに言い訳が付いていると、使えないように読める。"""
    for cap in cs.snapshot():
        if cap["status"] in ("connected", "available"):
            assert not cap.get("why"), f"{cap['id']} は使えるのに理由が付いている"


def test_名前と_できることが必ずある():
    for cap in cs.snapshot():
        assert cap.get("id") and cap.get("name"), f"名前の無い項目: {cap}"
        assert isinstance(cap.get("tools"), list)


def test_idが重なっていない():
    ids = [c["id"] for c in cs.snapshot()]
    assert len(ids) == len(set(ids)), f"idが重なっている: {ids}"


# ── 現実とずれていないか ─────────────────────────────────────────────

def test_鍵が無ければ_設定が要ると言う(monkeypatch):
    monkeypatch.setattr(cs, "_key", lambda name: "")
    ai = cs.find("ai")
    assert ai["status"] == "configuration_required"
    assert "鍵" in ai["why"] or "キー" in ai["why"]


def test_鍵があれば_使えると言う(monkeypatch):
    monkeypatch.setattr(cs, "_key", lambda name: "AIza-xxxx" if name == "GEMINI_API_KEY" else "")
    ai = cs.find("ai")
    assert ai["status"] == "connected"
    assert not ai.get("why")


def test_繋いでいないOAuthは_繋いでいないと言う(monkeypatch):
    monkeypatch.setattr(cs, "_oauth_status",
                        lambda p: {"configured": True, "connected": False})
    cal = cs.find("google_calendar")
    assert cal["status"] == "not_connected"
    assert cal["action"]["kind"] == "oauth"


def test_アプリ登録がまだなら_持ち主の仕事だと分かる(monkeypatch):
    """「許可がまだ」と「そもそもアプリ登録がまだ」は別物。前者は自分で
    押せば済むが、後者は持ち主がやるまで押しても始まらない。"""
    monkeypatch.setattr(cs, "_oauth_status",
                        lambda p: {"configured": False, "connected": False})
    cal = cs.find("google_calendar")
    assert cal["status"] == "configuration_required"
    assert cal.get("needs_owner") is True


def test_繋いでいれば_繋がっていると言う(monkeypatch):
    monkeypatch.setattr(cs, "_oauth_status",
                        lambda p: {"configured": True, "connected": True, "account": "me@example.com"})
    cal = cs.find("google_calendar")
    assert cal["status"] == "connected"
    assert cal.get("account") == "me@example.com"


def test_切ってある機能は_使えないではなく_切ってあると言う(monkeypatch):
    """パックを切っているのは利用者自身の選択。「使えません」と言うと
    壊れているように読める。"""
    monkeypatch.setattr(cs, "_packs_on", lambda is_owner: {"core"})
    dev = cs.find("github", is_owner=True)
    assert dev["status"] == "unavailable"
    assert "切" in dev["why"] or "使わない" in dev["why"]
    assert dev["action"]["kind"] == "pack"


def test_持ち主だけの機能は_他の人に出さない(monkeypatch):
    ids = {c["id"] for c in cs.snapshot(is_owner=False)}
    assert "income" not in ids


# ── 落ちないこと ────────────────────────────────────────────────────

def test_調べる途中で落ちても_全体は返る(monkeypatch):
    """1つの連携先が落ちただけで、自己診断そのものが出なくなっては困る。
    そこがいちばん見たい瞬間だから。"""
    def boom(_p):
        raise RuntimeError("Supabase down")
    monkeypatch.setattr(cs, "_oauth_status", boom)
    snap = cs.snapshot()
    assert snap, "まるごと空になっている"
    broken = [c for c in snap if c["status"] == "error"]
    assert broken, "落ちたのに error として出ていない"
    for c in broken:
        assert c.get("why"), "error なのに何が起きたか書いていない"


def test_知らないidを聞かれても落ちない():
    assert cs.find("そんなものは無い") is None


# ── まとめ（会話でそのまま読める形） ──────────────────────────────────

def test_要約は_使える物と使えない物を分ける():
    text = cs.summary()
    assert text.strip(), "何も出ていない"
    # 使えない物には必ず次の一手が添う
    for cap in cs.snapshot():
        if cap["status"] not in ("connected", "available"):
            assert cap["name"] in text, f"{cap['name']} が要約から落ちている"


def test_要約に_鍵そのものが混ざらない(monkeypatch):
    """自己診断は会話へ流れる。ここに鍵が混ざると、そのままAIへ渡る。"""
    secret = "AIzaSyTOPSECRETVALUE1234567890"
    monkeypatch.setattr(cs, "_key", lambda name: secret)
    text = cs.summary()
    assert secret not in text
    for cap in cs.snapshot():
        assert secret not in repr(cap), f"{cap['id']} に鍵が乗っている"
