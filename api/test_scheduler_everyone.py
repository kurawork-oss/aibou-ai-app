# test_scheduler_everyone.py — 「毎朝LINEに通知して」が本当に届くか
#
# 利用者の質問: 「エージェントに毎朝LINEに◯◯って通知してってお願いしたら
# ちゃんとしてくれるの？ トリガーも勝手にやってくれる？」
#
# 調べたら、持ち主以外では動かなかった。
#
#   ・常駐ループは60秒ごとに scheduler.tick() を呼んでいた
#   ・tick() はリクエスト文脈を持たないので、保存先はサーバー既定のDBになる
#   ・各自の予約は各自のDBにあるので、見えない＝永久に発火しない
#   ・鍵も同じで、その人のLINEトークンはその人のDBにある。仮に発火しても
#     送り先が無い
#
# 登録はできて「登録しました」と返るのに、朝になっても何も来ない。
# 原因を追う手がかりもない、いちばん質の悪い壊れ方だった。

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import scheduler
import tenancy


@pytest.fixture(autouse=True)
def clean():
    scheduler._mem_schedules.clear() if hasattr(scheduler, "_mem_schedules") else None
    tenancy._mem_rows.clear()
    tenancy._clients.clear()
    yield
    tenancy._mem_rows.clear()
    tenancy._clients.clear()


def test_the_loop_runs_everyone_not_just_the_default(monkeypatch):
    """ここが本題。人ごとに保存先を差し替えてから回すこと。"""
    seen = []

    def fake_tick(user_id=""):
        # そのときバインドされている保存先を記録する
        seen.append(config.get_supabase())
        return {"ran": [], "count": 0}

    a, b = object(), object()
    monkeypatch.setattr(scheduler, "tick", fake_tick)
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["u-a", "u-b"])
    monkeypatch.setattr(tenancy, "client_for", lambda uid: {"u-a": a, "u-b": b}.get(uid))

    out = scheduler.tick_everyone()

    assert out["users"] == 2
    # 既定 + 2人ぶん = 3回。それぞれ違う保存先で回っている
    assert len(seen) == 3
    assert a in seen and b in seen


def test_each_user_sees_their_own_database(monkeypatch):
    """Aさんの予約がBさんのDBで実行されると、他人の予定が勝手に動く。"""
    ran_for = []

    def fake_tick(user_id=""):
        client = config.get_supabase()
        ran_for.append(getattr(client, "name", "default"))
        return {"ran": [], "count": 0}

    class C:
        def __init__(self, name): self.name = name

    monkeypatch.setattr(scheduler, "tick", fake_tick)
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["u-a", "u-b"])
    monkeypatch.setattr(tenancy, "client_for",
                        lambda uid: C("Aさん") if uid == "u-a" else C("Bさん"))

    scheduler.tick_everyone()
    assert ran_for == ["default", "Aさん", "Bさん"]


def test_the_binding_is_released_afterwards(monkeypatch):
    """差し替えたまま抜けると、次のリクエストが他人のDBを掴む。"""
    monkeypatch.setattr(scheduler, "tick", lambda user_id="": {"ran": [], "count": 0})
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["u-a"])
    monkeypatch.setattr(tenancy, "client_for", lambda uid: object())

    before = config.storage_is_bound()
    scheduler.tick_everyone()
    assert config.storage_is_bound() is before


def test_one_broken_user_does_not_stop_the_others(monkeypatch):
    """1人のDBが落ちていても、他の人の朝の通知は届くべき。"""
    ok = []

    def fake_tick(user_id=""):
        c = config.get_supabase()
        if getattr(c, "broken", False):
            raise RuntimeError("そのDBに繋がりません")
        ok.append(c)
        return {"ran": [{"id": "1"}], "count": 1}

    class Broken: broken = True

    monkeypatch.setattr(scheduler, "tick", fake_tick)
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["bad", "good"])
    monkeypatch.setattr(tenancy, "client_for",
                        lambda uid: Broken() if uid == "bad" else object())

    out = scheduler.tick_everyone()
    assert out["users"] == 1          # 動いたのは1人
    assert len(ok) == 2               # 既定 + goodさん


def test_results_are_added_up(monkeypatch):
    monkeypatch.setattr(scheduler, "tick",
                        lambda user_id="": {"ran": [{"id": "x"}], "count": 1})
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["u-a", "u-b"])
    monkeypatch.setattr(tenancy, "client_for", lambda uid: object())

    out = scheduler.tick_everyone()
    assert out["count"] == 3          # 既定 + 2人
    assert len(out["ran"]) == 3


def test_nobody_connected_still_runs_the_default(monkeypatch):
    """1人運用でも、これまで通り自分の予約は動く。"""
    calls = []
    monkeypatch.setattr(scheduler, "tick", lambda user_id="": calls.append(1) or {"ran": [], "count": 0})
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: [])

    out = scheduler.tick_everyone()
    assert len(calls) == 1
    assert out["users"] == 0


def test_a_broken_ledger_does_not_kill_the_default(monkeypatch):
    """接続台帳が読めなくても、既定ぶんは回す。"""
    calls = []
    monkeypatch.setattr(scheduler, "tick", lambda user_id="": calls.append(1) or {"ran": [], "count": 0})

    def boom():
        raise RuntimeError("台帳が読めません")

    monkeypatch.setattr(tenancy, "all_connected_users", boom)

    out = scheduler.tick_everyone()
    assert len(calls) == 1
    assert out["users"] == 0


# ── 誰が繋いでいるかを知る ───────────────────────────────────────
def test_connected_users_are_listed(monkeypatch):
    monkeypatch.setattr(tenancy, "check", lambda u, k: {"ok": True, "tables_ready": True})
    monkeypatch.setattr(tenancy, "client_for", lambda uid: None)
    monkeypatch.setattr(tenancy, "verify_writable", lambda c: {"ok": True})

    tenancy.connect("u-a", "https://a.supabase.co", "k" * 50)
    tenancy.connect("u-b", "https://b.supabase.co", "k" * 50)

    ids = tenancy.all_connected_users()
    assert set(ids) == {"u-a", "u-b"}


def test_disconnected_users_drop_out(monkeypatch):
    monkeypatch.setattr(tenancy, "check", lambda u, k: {"ok": True, "tables_ready": True})
    monkeypatch.setattr(tenancy, "client_for", lambda uid: None)
    monkeypatch.setattr(tenancy, "verify_writable", lambda c: {"ok": True})

    tenancy.connect("u-a", "https://a.supabase.co", "k" * 50)
    tenancy.disconnect("u-a")
    assert tenancy.all_connected_users() == []


# ── LINEに届くか（利用者の質問の本体） ───────────────────────────
def test_the_notification_uses_that_persons_own_line_token(monkeypatch):
    """予約が発火しても、鍵が他人のものでは届かない。

    鍵はその人のDBにある。tick_everyone が保存先を差し替えてから回すので、
    keychain も自動的にその人のものを見る。ここが繋がっていないと、
    「登録しました」と言われて朝になっても何も来ない。
    """
    import keychain
    import notify

    tokens = {"Aさん": "line-token-A", "Bさん": "line-token-B"}
    sent = []

    class C:
        def __init__(self, name): self.name = name

    def fake_get_key(name):
        if name != "LINE_CHANNEL_TOKEN":
            return ""
        c = config.get_supabase()
        return tokens.get(getattr(c, "name", ""), "")

    monkeypatch.setattr(keychain, "get_key", fake_get_key)
    monkeypatch.setattr(notify.keychain, "get_key", fake_get_key)
    monkeypatch.setattr(notify, "_post_json",
                        lambda url, payload, headers=None:
                        sent.append(headers["Authorization"]) or True)

    def fake_tick(user_id=""):
        notify.send_line("おはようございます")
        return {"ran": [], "count": 0}

    monkeypatch.setattr(scheduler, "tick", fake_tick)
    monkeypatch.setattr(tenancy, "all_connected_users", lambda: ["u-a", "u-b"])
    monkeypatch.setattr(tenancy, "client_for",
                        lambda uid: C("Aさん") if uid == "u-a" else C("Bさん"))

    scheduler.tick_everyone()

    # それぞれのトークンで送られている（取り違えていない）
    assert "Bearer line-token-A" in sent
    assert "Bearer line-token-B" in sent
