"""
秘密を、記憶に入れない（仕様§12・§22）。

なぜ要るか
----------
このアプリは会話を長期記憶に入れる。入れる先は
  ・端末の中（IndexedDB）
  ・サーバー側（Supabase の agent_memory）
で、どちらも**あとで会話に混ぜてAIへ渡る**。

つまり、会話の中で1度でも鍵を口にすると、それが記憶に残り、以後ずっと
毎回AIへ送られる。

    「GEMINIのキー、AIzaSyC... これで合ってる？」
      → そのまま記憶に入る
      → 以後、関係ない話でも「関連する記憶」として毎回添付される

鍵は Credential Vault（暗号化して保存し、AIには渡さない）が持つべき物で、
記憶が持つ物ではない。仕様§12「CredentialをLLMへ直接渡さない」、
§22「API KeyやPasswordをMemoryへ保存しない」。

どちらへ倒すか
--------------
**迷ったら入れない。** 鍵らしき文字列を覚え損ねても、失うのは利便性だけ。
逆を間違えると、秘密が残り続ける。ただし「パスワードを変えた」のような
**鍵そのものを含まない文**は、ふつうの記憶として残す（そこまで弾くと、
生活の記録が穴だらけになる）。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import secrets_guard as sg


# ── 入れてはいけない物 ──────────────────────────────────────────────

# 見本の鍵は、**その場で組み立てる**。
#
# 本物そっくりの文字列をファイルに直接書くと、GitHub の秘密検出に
# 引っかかって push そのものが止まる（実際に止まった）。中身は作り物だが、
# 形が本物と同じなのだから当然で、検出側が正しい。
#
# 頭の印（AIza・sk-ant- など）だけ残し、続きはここで伸ばす。
# テストしたいのは「その形を見つけられるか」なので、これで足りる。
_BODY = "abcdefghijklmnopqrstuvwxyz0123456789" * 3


def _fake(prefix: str, n: int = 36) -> str:
    return prefix + _BODY[:n]


SECRETS = [
    _fake("AIza", 35),                                  # Google
    _fake("sk-" + "ant-api03-", 36),                    # Anthropic
    _fake("sk-" + "proj-", 36),                         # OpenAI
    _fake("hf_", 34),                                   # HuggingFace
    "xox" + "b-123456789012-1234567890123-" + _BODY[:24],   # Slack
    _fake("gh" + "p_", 36),                             # GitHub
    _fake("secret_", 40),                               # Notion
    # 署名つきトークン（JWT）
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0." + _BODY[:20],
    "postgresql://user:hunter2@db.example.com:5432/postgres",   # 接続文字列
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
]


@pytest.mark.parametrize("text", SECRETS)
def test_鍵が混ざった文は_記憶に入れない(text):
    assert sg.has_secret(text), f"素通りしている: {text[:30]}"


@pytest.mark.parametrize("text", SECRETS)
def test_鍵が混ざった文は_理由が言える(text):
    why = sg.why(text)
    assert why, "なぜ弾いたのか分からない"
    # 理由に鍵そのものを載せない（理由は画面にもログにも出る）
    assert text[:20] not in why


def test_前後に文があっても見つける():
    assert sg.has_secret(f"これ合ってる？ {_fake('sk-' + 'ant-api03-', 36)} でいい？")


def test_パスワードの書き付けも弾く():
    for text in [
        "Wi-Fiのパスワードは Tr0ub4dor&3xK9 です",
        "password: hunter2hunter2",
        "パスワード：あいうえお12345678",
    ]:
        assert sg.has_secret(text), f"素通りしている: {text}"


# ── ふつうの文は、そのまま残す ────────────────────────────────────

SAFE = [
    "甲殻類アレルギーがある",
    "打ち合わせは毎週火曜の15時から",
    "パスワードを変えた",                      # 鍵そのものは無い
    "GEMINI_API_KEY を設定した",               # 名前だけ
    "コーヒーはブラックが好き",
    "田中さんのメールは tanaka@example.com",   # 連絡先は秘密ではない
    "明日は10時から歯医者",
    "https://example.com/articles/2026/09 を読んだ",
    "住所は東京都世田谷区",
]


@pytest.mark.parametrize("text", SAFE)
def test_ふつうの文は_そのまま覚える(text):
    assert not sg.has_secret(text), f"覚えるべき物を弾いた: {text}"


def test_短い英数字の並びで_誤爆しない():
    """注文番号や型番まで弾くと、記憶が穴だらけになる。"""
    for text in ["注文番号は A1B2C3D4", "型番 XPS-9520", "会議室は 302B"]:
        assert not sg.has_secret(text), f"誤爆: {text}"


def test_空でも落ちない():
    assert not sg.has_secret("")
    assert not sg.has_secret(None)


# ── 隠す（残したいが、鍵だけ伏せる） ──────────────────────────────

def test_伏せると_鍵が消えて文は残る():
    text = f"キーは {_fake('sk-' + 'ant-api03-', 36)} だよ"
    out = sg.redact(text)
    assert "ant-api03" not in out
    assert "キーは" in out and "だよ" in out
    assert sg.MASK in out


def test_伏せた文には_もう秘密が無い():
    for text in SECRETS:
        assert not sg.has_secret(sg.redact(text)), f"伏せきれていない: {text[:30]}"


def test_ふつうの文は_伏せても変わらない():
    for text in SAFE:
        assert sg.redact(text) == text


# ── 実際の入口で効いているか ──────────────────────────────────────

class _Rows:
    """書き込みだけ数える、最小のSupabaseの代わり。"""

    def __init__(self, sink):
        self.sink = sink

    def insert(self, row):
        self.sink.append(row)
        return type("R", (), {"execute": lambda _s: None})()

    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def order(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def execute(self): return type("R", (), {"data": []})()


class _Db:
    def __init__(self):
        self.wrote = []

    def table(self, _name):
        return _Rows(self.wrote)

    def rpc(self, *a, **k):
        raise RuntimeError("no rpc")


@pytest.fixture
def db(monkeypatch):
    import memory_store
    fake = _Db()
    monkeypatch.setattr(memory_store, "get_supabase", lambda: fake)
    monkeypatch.setattr(memory_store, "embed", lambda *_a, **_k: None)
    return fake


def test_記憶に入れる所で_止まる(db):
    """ここが本番。会話をそのまま記憶に入れる所で止まっていること。"""
    import memory_store
    memory_store.mem_add("user", f"鍵は {_fake('sk-' + 'ant-api03-', 36)}")
    assert not db.wrote, f"秘密が保存された: {db.wrote}"


def test_ふつうの発言は_これまで通り入る(db):
    import memory_store
    memory_store.mem_add("user", "甲殻類アレルギーがある")
    assert db.wrote, "ふつうの発言まで止めている"
