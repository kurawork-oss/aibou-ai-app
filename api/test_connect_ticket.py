"""
連携の入口を、ログインを求める構成でも開けること（oauth の使い捨ての札）。

見つけたこと
------------
連携の「押すだけ」は、入口（/connect/{provider}/start）を**新しいタブの
ただのリンク**で開く。ただのリンクには、画面が普段付けているログイン情報
（Authorization の見出し）が載らない。だから:

    APP_TOKEN や REQUIRE_AUTH を置いた構成 … 入口が 401 で、連携を始められない
    （通ったとしても）                      … 「誰が始めたか」が空になる

OAuth のアプリ登録がまだなので、本番ではまだ誰も踏んでいなかった。登録した
その日に、全部の「連携」ボタンが動かないことになっていた。

いまは、画面がまず**ログイン情報つきで**札をもらい、札を付けて新しいタブを
開く。札は その提供元だけ・2分・1回きり・署名つき。
"""

import os
import sys
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import keychain
import oauth
from main import app

client = TestClient(app)
SECRET = "ticket-test-jwt-secret"
APP = "ticket-app-token"


def _jwt(sub="u-alice", email="alice@example.com"):
    import jwt as pyjwt
    return pyjwt.encode({"sub": sub, "email": email, "aud": "authenticated",
                         "exp": 9999999999}, SECRET, algorithm="HS256")


@pytest.fixture(autouse=True)
def server(monkeypatch):
    """ログインを求める構成（人に配るときの形）。Notion のアプリ登録は済み。"""
    monkeypatch.setattr(config, "APP_TOKEN", APP)
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(config, "REQUIRE_AUTH", True)
    monkeypatch.setattr(config, "OWNER_EMAIL", "")
    monkeypatch.setattr(config, "OWNER_USER_ID", "")
    real = keychain.get_key
    monkeypatch.setattr(keychain, "get_key", lambda name: {
        "NOTION_CLIENT_ID": "nid", "NOTION_CLIENT_SECRET": "nsec",
        "GOOGLE_CLIENT_ID": "gid", "GOOGLE_CLIENT_SECRET": "gsec",
    }.get(name) or real(name))
    oauth._used_tickets.clear()
    yield
    oauth._used_tickets.clear()


def _signed_in():
    """画面（lib/api.ts の authHeaders）が付ける見出し。"""
    return {"Authorization": f"Bearer {APP}", "X-Supabase-Token": _jwt()}


def _ticket(provider="notion"):
    r = client.post(f"/connect/{provider}/ticket", headers=_signed_in())
    assert r.status_code == 200, r.text
    return r.json()["ticket"]


def test_a_plain_link_without_a_ticket_is_turned_away():
    """直した穴の、もとの姿。新しいタブのただのリンクには見出しが無い。"""
    r = client.get("/connect/notion/start", follow_redirects=False)
    assert r.status_code == 401
    assert "連携" in r.text


def test_a_ticket_opens_the_door_without_headers():
    r = client.get(f"/connect/notion/start?ticket={_ticket()}", follow_redirects=False)
    assert r.status_code in (302, 307), r.text
    assert "api.notion.com" in r.headers["location"]


def test_the_ticket_carries_who_started_it():
    """戻ってきたときに、始めた本人の保管庫へ入れるため。"""
    r = client.get(f"/connect/notion/start?ticket={_ticket()}", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    assert oauth.verify_state(state, "notion")["user_id"] == "u-alice"


def test_a_ticket_works_once():
    t = _ticket()
    assert client.get(f"/connect/notion/start?ticket={t}",
                      follow_redirects=False).status_code in (302, 307)
    again = client.get(f"/connect/notion/start?ticket={t}", follow_redirects=False)
    assert again.status_code == 400 and "もう使われています" in again.text


def test_a_ticket_is_for_one_provider():
    t = _ticket("google")
    r = client.get(f"/connect/notion/start?ticket={t}", follow_redirects=False)
    assert r.status_code == 400 and "別の連携" in r.text


def test_a_ticket_goes_stale(monkeypatch):
    t = _ticket()
    later = time.time() + oauth.TICKET_TTL + 5
    monkeypatch.setattr(oauth.time, "time", lambda: later)
    r = client.get(f"/connect/notion/start?ticket={t}", follow_redirects=False)
    assert r.status_code == 400 and "時間が経ちすぎ" in r.text


def test_a_forged_ticket_is_refused():
    body, _, sig = _ticket().partition(".")
    forged = body[:-2] + ("AA" if not body.endswith("AA") else "BB") + "." + sig
    r = client.get(f"/connect/notion/start?ticket={forged}", follow_redirects=False)
    assert r.status_code == 400


def test_nobody_gets_a_ticket_without_logging_in():
    r = client.post("/connect/notion/ticket")
    assert r.status_code == 401


def test_the_google_door_takes_a_ticket_too():
    """Google だけ以前からの道（/google/auth/start）。同じ札で開く。"""
    r = client.get(f"/google/auth/start?ticket={_ticket('google')}", follow_redirects=False)
    assert r.status_code in (302, 307) and "accounts.google.com" in r.headers["location"]


def test_an_open_server_still_works_without_a_ticket(monkeypatch):
    """ログインを求めない構成（1人運用）は、これまで通りリンクだけで開く。"""
    monkeypatch.setattr(config, "APP_TOKEN", "")
    monkeypatch.setattr(config, "REQUIRE_AUTH", False)
    r = client.get("/connect/notion/start", follow_redirects=False)
    assert r.status_code in (302, 307)


def test_a_ticket_is_not_accepted_as_a_callback_state():
    """札と state は同じ鍵・同じ形で署名している。取り違えて通さない。

    札は画面の中にしか出ないが、戻り（callback）で state として通ると、
    別の人の札で、自分のアカウントをその人に繋がせることができてしまう。
    """
    ticket = oauth.make_ticket("u-alice", "notion")
    assert ticket
    assert "error" in oauth.verify_state(ticket, "notion")
    # 逆向き（state を札として使う）も通らない
    state = oauth.sign_state("u-alice", "notion")
    assert "error" in oauth.use_ticket(state, "notion")
