# test_x_post.py — Xへの実投稿の検証
#
# これまでSNSモードは文案を作るだけで、投稿は人が手で貼っていた。
# 「投稿できると思ったのにできない」状態だったので実装した。
#
# 投稿は取り返しがつかない。だから確かめたいのは主に「勝手に投稿しないこと」と
# 「失敗したときに理由が分かること」。ネットワークには一切出ない。

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import x_client


@pytest.fixture
def keys(monkeypatch):
    store = {}
    monkeypatch.setattr(x_client, "_k", lambda n: store.get(n, ""))
    return store


def _full(store):
    store.update({
        "X_API_KEY": "ck", "X_API_SECRET": "cs",
        "X_ACCESS_TOKEN": "at", "X_ACCESS_SECRET": "as",
    })


@pytest.fixture
def sent(monkeypatch):
    """送信を記録するだけ。実際のXには出さない。"""
    calls = []

    class FakeResp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"data":{"id":"1234567890"}}'

    def fake_urlopen(req, timeout=None):
        calls.append({
            "url": req.full_url,
            "body": req.data.decode("utf-8"),
            "auth": req.headers.get("Authorization", ""),
        })
        return FakeResp()

    monkeypatch.setattr(x_client.urllib.request, "urlopen", fake_urlopen)
    return calls


# ── 文字数（Xの数え方） ─────────────────────────────────────────
def test_japanese_counts_as_two_per_character():
    """素朴に len() で数えると、日本語が280字入ると表示して投稿後に弾かれる。"""
    assert x_client.weighted_len("hello") == 5
    assert x_client.weighted_len("こんにちは") == 10
    assert x_client.fits("あ" * 140) is True
    assert x_client.fits("あ" * 141) is False
    assert x_client.fits("a" * 280) is True
    assert x_client.fits("a" * 281) is False


def test_too_long_is_refused_before_sending(keys, sent):
    _full(keys)
    r = x_client.post("あ" * 200)
    assert "280字" in r["error"]
    assert "1文字が2つ分" in r["error"]      # なぜ超えたのかまで言う
    assert sent == []                        # 通信もしない


# ── 未設定 ───────────────────────────────────────────────────────
def test_missing_keys_are_named(keys, sent):
    keys["X_API_KEY"] = "ck"                 # 1つだけ入れた状態
    r = x_client.post("こんにちは")
    assert "X_API_SECRET" in r["error"]
    assert "連携" in r["error"]
    assert sent == []


def test_empty_text_is_refused(keys, sent):
    _full(keys)
    assert "空" in x_client.post("   ")["error"]
    assert sent == []


# ── 勝手に投稿しない ─────────────────────────────────────────────
def test_agents_cannot_post_by_default(keys, sent):
    """自動実行から勝手に投稿されるのが一番こわい。既定で止める。"""
    _full(keys)
    r = x_client.post("自動投稿のテスト", by_agent=True)
    assert "自動での投稿は既定で止めています" in r["error"]
    assert sent == []


def test_agents_can_post_only_after_an_explicit_opt_in(keys, sent):
    _full(keys)
    keys["X_ALLOW_AUTOPOST"] = "1"
    r = x_client.post("自動投稿のテスト", by_agent=True)
    assert r.get("ok") is True
    assert len(sent) == 1


def test_a_person_pressing_the_button_can_post(keys, sent):
    _full(keys)
    r = x_client.post("手で押した投稿")
    assert r["ok"] is True
    assert r["id"] == "1234567890"
    assert r["url"].endswith("/1234567890")
    assert len(sent) == 1


# ── 送っている中身 ───────────────────────────────────────────────
def test_the_request_looks_like_x_expects(keys, sent):
    _full(keys)
    x_client.post("テスト投稿")
    call = sent[0]
    assert call["url"] == x_client.API_URL
    assert '"text": "\\u30c6\\u30b9\\u30c8\\u6295\\u7a3f"' in call["body"] or "テスト投稿" in call["body"]
    # OAuth 1.0a の必須項目がそろっているか
    for part in ["oauth_consumer_key", "oauth_nonce", "oauth_signature",
                 "oauth_signature_method", "oauth_timestamp", "oauth_token"]:
        assert part in call["auth"], f"{part} が署名に無い"
    assert 'oauth_signature_method="HMAC-SHA1"' in call["auth"]


def test_secrets_never_appear_in_the_header(keys, sent):
    """署名にシークレットそのものを載せてしまう実装ミスを見張る。"""
    _full(keys)
    keys["X_API_SECRET"] = "super-secret-consumer"
    keys["X_ACCESS_SECRET"] = "super-secret-access"
    x_client.post("テスト")
    auth = sent[0]["auth"]
    assert "super-secret-consumer" not in auth
    assert "super-secret-access" not in auth


def test_the_signature_changes_per_request(keys, sent):
    """nonce/timestamp が固定だと、Xに使い回しとして弾かれる。"""
    _full(keys)
    x_client.post("1回目")
    x_client.post("2回目")
    assert sent[0]["auth"] != sent[1]["auth"]


# ── 失敗の言い換え ───────────────────────────────────────────────
@pytest.mark.parametrize("code,want", [
    (401, "貼り直して"),
    (403, "Read and write"),
    (429, "上限"),
    (500, "X側が不調"),
])
def test_x_errors_say_what_to_do(keys, monkeypatch, code, want):
    _full(keys)

    class Err(x_client.urllib.error.HTTPError):
        def __init__(self):
            super().__init__("u", code, "e", {}, None)
        def read(self): return b"{}"

    def boom(req, timeout=None):
        raise Err()

    monkeypatch.setattr(x_client.urllib.request, "urlopen", boom)
    assert want in x_client.post("テスト")["error"]


def test_status_never_returns_the_keys(keys):
    _full(keys)
    st = x_client.status()
    assert st["configured"] is True
    assert st["autopost_allowed"] is False
    assert "ck" not in str(st) and "cs" not in str(st)
