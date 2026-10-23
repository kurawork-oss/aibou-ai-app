# test_jwt_methods.py — ログイン用トークンの検証方式
#
# Supabase には署名の方式が2つある。
#   共有シークレット(HS256) … 古いプロジェクト
#   公開鍵(ES256/RS256)     … 現在の既定
# HS256 だけに対応していると、公開鍵方式のプロジェクトでは「正しい秘密鍵を
# 入れたのに永久に検証できない」状態になり、全部401になる（実際に踏んだ）。
# 両方が通ること、偽物は通らないことを確かめる。

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import main

CLAIMS = {"sub": "user-1", "email": "me@example.com",
          "aud": "authenticated", "exp": 9999999999}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(main, "_jwks_client", None, raising=False)
    monkeypatch.setattr(main, "_jwks_uri", "", raising=False)
    yield


def _es256_keypair():
    from cryptography.hazmat.primitives.asymmetric import ec
    return ec.generate_private_key(ec.SECP256R1())


def _jwk_from(public_key, kid="test-key"):
    """公開鍵を JWKS の1件に整形する。"""
    import base64
    nums = public_key.public_numbers()
    b64 = lambda n: base64.urlsafe_b64encode(                     # noqa: E731
        n.to_bytes(32, "big")).decode().rstrip("=")
    return {"kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig",
            "kid": kid, "x": b64(nums.x), "y": b64(nums.y)}


def _serve_jwks(monkeypatch, jwks: dict):
    """公開鍵の置き場を、ネットワークなしで差し替える。

    取りに行く所（PyJWKClient.fetch_data）そのものを差し替える。以前は
    urllib.request.urlopen を差し替えていたが、PyJWT 2.11 以降は
    build_opener(...).open() で取りに行く（転送を断るため）ので、差し替えが
    効かずに本物のネットワークへ出て、テストだけが落ちていた。"""
    import copy
    import io
    import urllib.request

    import jwt as pyjwt

    monkeypatch.setattr(pyjwt.PyJWKClient, "fetch_data",
                        lambda self: copy.deepcopy(jwks))

    # /diagnose は鍵の数を自分で数えに行く（urlopen）。こちらも差し替える
    class Res(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda url, *a, **k: Res(json.dumps(jwks).encode()))


# ── 公開鍵方式（いまのSupabaseの既定）────────────────────────────
def test_an_asymmetric_token_is_accepted(monkeypatch):
    """公開鍵で署名されたトークンが通ること。ここが今回の本命。"""
    import jwt as pyjwt

    key = _es256_keypair()
    token = pyjwt.encode(CLAIMS, key, algorithm="ES256",
                         headers={"kid": "test-key"})

    monkeypatch.setattr(config, "SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "")   # 秘密鍵は無くてよい
    _serve_jwks(monkeypatch, {"keys": [_jwk_from(key.public_key())]})

    claims = main._decode_supabase_jwt(token)
    assert claims is not None, "公開鍵方式のトークンが検証できていない"
    assert claims["sub"] == "user-1"


def test_a_wrong_key_is_refused(monkeypatch):
    """別の鍵で署名されたものは通さないこと。"""
    import jwt as pyjwt

    real, attacker = _es256_keypair(), _es256_keypair()
    token = pyjwt.encode(CLAIMS, attacker, algorithm="ES256",
                         headers={"kid": "test-key"})

    monkeypatch.setattr(config, "SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "")
    _serve_jwks(monkeypatch, {"keys": [_jwk_from(real.public_key())]})

    assert main._decode_supabase_jwt(token) is None, "偽の署名が通っている"


# ── 共有シークレット方式（古いプロジェクト）──────────────────────
def test_a_shared_secret_token_still_works(monkeypatch):
    """従来のHS256も引き続き通ること（対応を増やしても減らさない）。"""
    import jwt as pyjwt

    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "the-shared-secret")
    monkeypatch.setattr(config, "SUPABASE_URL", "")
    token = pyjwt.encode(CLAIMS, "the-shared-secret", algorithm="HS256")
    assert main._decode_supabase_jwt(token)["sub"] == "user-1"


def test_a_wrong_shared_secret_is_refused(monkeypatch):
    import jwt as pyjwt

    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "the-shared-secret")
    monkeypatch.setattr(config, "SUPABASE_URL", "")
    token = pyjwt.encode(CLAIMS, "a-different-secret", algorithm="HS256")
    assert main._decode_supabase_jwt(token) is None


def test_both_methods_coexist(monkeypatch):
    """片方の設定が残っていても、もう片方の本物は通ること。"""
    import jwt as pyjwt

    key = _es256_keypair()
    monkeypatch.setattr(config, "SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "leftover-secret")
    _serve_jwks(monkeypatch, {"keys": [_jwk_from(key.public_key())]})

    asym = pyjwt.encode(CLAIMS, key, algorithm="ES256", headers={"kid": "test-key"})
    sym = pyjwt.encode(CLAIMS, "leftover-secret", algorithm="HS256")
    assert main._decode_supabase_jwt(asym) is not None, "公開鍵が通らない"
    assert main._decode_supabase_jwt(sym) is not None, "共有シークレットが通らない"


# ── 壊れた入力で落ちないこと ──────────────────────────────────────
def test_junk_never_raises(monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "s")
    _serve_jwks(monkeypatch, {"keys": []})
    for junk in ["", "abc", "a.b.c", "..", None]:
        assert main._decode_supabase_jwt(junk) is None


def test_expired_tokens_are_refused(monkeypatch):
    import jwt as pyjwt

    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "s")
    monkeypatch.setattr(config, "SUPABASE_URL", "")
    old = dict(CLAIMS, exp=1)
    assert main._decode_supabase_jwt(pyjwt.encode(old, "s", algorithm="HS256")) is None


# ── 方式を画面で確かめられること ──────────────────────────────────
def test_diagnose_tells_you_which_method_the_project_uses(monkeypatch):
    from fastapi.testclient import TestClient

    key = _es256_keypair()
    monkeypatch.setattr(config, "SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "")
    _serve_jwks(monkeypatch, {"keys": [_jwk_from(key.public_key())]})

    d = TestClient(main.app).get("/diagnose").json()["ログインの方式"]
    assert d["公開鍵の数"] == 1
    assert "ES256" in d["公開鍵の種類"]
    assert "公開鍵方式" in d["判定"]


def test_diagnose_says_so_when_the_project_is_shared_secret(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(config, "SUPABASE_URL", "https://proj.supabase.co")
    _serve_jwks(monkeypatch, {"keys": []})
    d = TestClient(main.app).get("/diagnose").json()["ログインの方式"]
    assert "共有シークレット" in d["判定"]
