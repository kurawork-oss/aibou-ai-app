# test_owner_only.py — 持ち主専用モードの検証
#
# 副業(INCOME)と自己進化(AI STUDIO)は持ち主だけのもの。画面から隠すだけでは
# URLを直接叩けば使えてしまうので、サーバー側で塞がっていることを確かめる。
#
# あわせて「設定し忘れで自分が締め出されない」ことも見る。オーナーを1つも
# 設定していない状態＝1人で使っている状態なので、全部使えるのが正しい。

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import main
from main import app

client = TestClient(app)

SECRET = "test-jwt-secret-for-owner-checks"

# 持ち主だけが使えるべき入口
OWNER_ENDPOINTS = [
    ("get", "/income/summary", None),
    ("get", "/income/jobs", None),
    ("post", "/income/enqueue", {"theme": "テスト"}),
    ("post", "/income/approve", {"id": "x"}),
    ("post", "/income/reject", {"id": "x"}),
    ("get", "/studio/ais", None),
    ("post", "/studio/ais", {"name": "a", "purpose": "b"}),
    ("get", "/studio/workflows", None),
    ("post", "/evolve/propose", {"instruction": "テスト"}),
]

# みんなが使える入口（塞ぎすぎていないことの確認）
SHARED_ENDPOINTS = [
    ("get", "/tasks", None),
    ("get", "/guide", None),
    ("get", "/memory/recent", None),
]


def token_for(sub: str, email: str) -> str:
    import jwt as pyjwt
    return pyjwt.encode(
        {"sub": sub, "email": email, "aud": "authenticated", "exp": 9999999999},
        SECRET, algorithm="HS256",
    )


def call(method: str, path: str, body, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    fn = getattr(client, method)
    if body is None:
        return fn(path, headers=headers)
    return fn(path, json=body, headers=headers)


@pytest.fixture
def owner_is_set(monkeypatch):
    """オーナーを設定した状態（人に配るときの構成）。"""
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(config, "OWNER_EMAIL", "boss@example.com")
    monkeypatch.setattr(config, "OWNER_USER_ID", "")
    monkeypatch.setattr(config, "REQUIRE_AUTH", False)
    monkeypatch.setattr(config, "APP_TOKEN", "")


# ── 持ち主以外は使えない ──────────────────────────────────────────
@pytest.mark.parametrize("method,path,body", OWNER_ENDPOINTS)
def test_employee_cannot_use_owner_modes(owner_is_set, method, path, body):
    r = call(method, path, body, token_for("emp-1", "employee@example.com"))
    assert r.status_code == 403, f"{path} を従業員が使えてしまう"


@pytest.mark.parametrize("method,path,body", OWNER_ENDPOINTS)
def test_signed_out_cannot_use_owner_modes(owner_is_set, method, path, body):
    """ログインしていない人も当然だめ。"""
    r = call(method, path, body, None)
    assert r.status_code == 403, f"{path} が未ログインでも使えてしまう"


@pytest.mark.parametrize("method,path,body", OWNER_ENDPOINTS)
def test_owner_can_use_owner_modes(owner_is_set, method, path, body):
    r = call(method, path, body, token_for("boss-1", "boss@example.com"))
    assert r.status_code != 403, f"持ち主が {path} を使えない"


def test_owner_match_is_not_case_sensitive(owner_is_set):
    r = call("get", "/income/jobs", None, token_for("boss-1", "BOSS@Example.COM"))
    assert r.status_code != 403


def test_owner_can_be_set_by_user_id(monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(config, "OWNER_EMAIL", "")
    monkeypatch.setattr(config, "OWNER_USER_ID", "boss-uuid")
    monkeypatch.setattr(config, "REQUIRE_AUTH", False)
    assert call("get", "/income/jobs", None, token_for("boss-uuid", "x@y.z")).status_code != 403
    assert call("get", "/income/jobs", None, token_for("other", "x@y.z")).status_code == 403


# ── 従業員が使う機能は塞がない ────────────────────────────────────
@pytest.mark.parametrize("method,path,body", SHARED_ENDPOINTS)
def test_shared_modes_stay_open_to_everyone(owner_is_set, method, path, body):
    r = call(method, path, body, token_for("emp-1", "employee@example.com"))
    assert r.status_code != 403, f"{path} は全員が使えるはず"


# ── オーナー未設定＝1人運用なら全部使える ─────────────────────────
def test_nothing_is_locked_when_no_owner_is_configured(monkeypatch):
    """設定し忘れで自分が締め出されないこと。"""
    monkeypatch.setattr(config, "OWNER_EMAIL", "")
    monkeypatch.setattr(config, "OWNER_USER_ID", "")
    monkeypatch.setattr(config, "REQUIRE_AUTH", False)
    for method, path, body in OWNER_ENDPOINTS:
        assert call(method, path, body, None).status_code != 403, path


# ── 画面が出し分けるための情報 ────────────────────────────────────
def test_profile_tells_the_ui_who_you_are(owner_is_set):
    r = call("get", "/account/profile", None, token_for("boss-1", "boss@example.com"))
    assert r.status_code == 200 and r.json()["is_owner"] is True

    r2 = call("get", "/account/profile", None, token_for("emp-1", "employee@example.com"))
    assert r2.status_code == 200
    d = r2.json()
    assert d["is_owner"] is False
    assert d["signed_in"] is True
    assert "income" in d["owner_only_modes"]


from contextlib import contextmanager


@contextmanager
def _packs_on(names):
    """使う機能のかたまりを、その場だけ差し替える。"""
    import capabilities
    real = capabilities.enabled_packs
    capabilities.enabled_packs = lambda is_owner=True: list(names)
    try:
        yield
    finally:
        capabilities.enabled_packs = real


def test_guide_hides_owner_only_modes_from_employees(owner_is_set):
    """使えない機能の説明が並ぶと「壊れている」と受け取られる。"""
    emp = call("get", "/guide", None, token_for("emp-1", "employee@example.com")).json()
    labels = [m["label"] for m in emp["modes"]]
    assert "INCOME" not in labels, "従業員の説明書に持ち主専用モードが出ている"
    assert emp["mode_count"] == len(emp["modes"])
    assert "CHAT" in labels and "TASKS" in labels        # 共通モードは出る

    # 持ち主でも、使う機能のかたまりを入れていなければ出ない。
    # INCOME の入口（管理 → もっと）も同じ条件なので、説明書だけ先に
    # 出しても行き先が無い。**入れてから**出る、が正しい。
    boss = call("get", "/guide", None, token_for("boss-1", "boss@example.com")).json()
    assert "INCOME" not in [m["label"] for m in boss["modes"]], \
        "副業を入れていないのに、説明書に出ている"

    import capabilities
    with _packs_on(["core", "income"]):
        boss2 = call("get", "/guide", None, token_for("boss-1", "boss@example.com")).json()
        assert "INCOME" in [m["label"] for m in boss2["modes"]], \
            "副業を入れたのに、説明書に出ない"
        assert boss2["mode_count"] == len(boss2["modes"])
        assert capabilities is not None


def test_owner_check_does_not_trust_the_client(owner_is_set):
    """署名されていない自称オーナーを通さないこと。"""
    import jwt as pyjwt
    forged = pyjwt.encode(
        {"sub": "x", "email": "boss@example.com", "aud": "authenticated", "exp": 9999999999},
        "wrong-secret", algorithm="HS256",
    )
    assert call("get", "/income/jobs", None, forged).status_code == 403
