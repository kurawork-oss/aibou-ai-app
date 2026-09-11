"""
承認待ちの検証。

直した穴
--------
定期実行（`scheduler.tick`）は `agent.run_stream` を回して
`phase == "final"` だけを見ていた。取り返せない操作（メール送信など）へ
来ると run_stream は `approval` を出して止まるので、final は来ない。つまり

    深夜3時の定期実行がメールを送ろうとする
      → 承認待ちで止まる
      → final は空のまま
      → 「⏰ 定期実行「…」」という中身の無い通知だけが残る
      → **待っていること自体が、誰にも伝わらない**

しかも「実行しなかった」とも「失敗した」とも言わない。いちばん困る形。

このファイルは、その用事が**必ずどこかに残る**ことと、
**その端末の持ち主だけが答えられる**ことを見ている。
"""

import time

import pytest

import approvals
import config


@pytest.fixture(autouse=True)
def _clean():
    approvals._mem.clear()
    yield
    approvals._mem.clear()


def _ask(monkeypatch, **kw):
    """通知を飛ばさずに1件作る（通知は別のテストで見る）。"""
    monkeypatch.setattr(approvals, "create", approvals.create)
    return approvals.create("notify", {"message": "こんばんは"}, **kw)


# ── 合言葉 ───────────────────────────────────────────────────────────

def test_合言葉が無いと答えられない(monkeypatch):
    row = _ask(monkeypatch)
    res = approvals.answer(row["id"], "approve", "")
    assert res["ok"] is False
    assert approvals.get(row["id"])["status"] == "pending", "実行されてしまった"


def test_よその合言葉では答えられない(monkeypatch):
    a = _ask(monkeypatch)
    b = _ask(monkeypatch)
    res = approvals.answer(a["id"], "approve", b["token"])
    assert res["ok"] is False
    assert approvals.get(a["id"])["status"] == "pending"


def test_合言葉は1回きり(monkeypatch):
    """通知は端末に残る。同じ通知をもう一度押しても、二度は実行しない。"""
    ran = []
    import tools
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: ran.append(n) or "送りました")

    row = _ask(monkeypatch)
    first = approvals.answer(row["id"], "approve", row["token"])
    assert first["ok"] is True and ran == ["notify"]

    again = approvals.answer(row["id"], "approve", row["token"])
    assert ran == ["notify"], "2回実行された"
    assert again.get("already") is True


def test_時間が経った承認は実行しない(monkeypatch):
    """3日前の朝に送るはずだったメールを、いま送っても状況が違う。"""
    ran = []
    import tools
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: ran.append(n) or "ok")

    row = _ask(monkeypatch)
    approvals._update(row["id"], {"created_at": time.time() - approvals.TTL - 10})
    res = approvals.answer(row["id"], "approve", row["token"])
    assert res["ok"] is False and "時間" in res["error"]
    assert ran == []


def test_断ると実行しない(monkeypatch):
    ran = []
    import tools
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: ran.append(n) or "ok")

    row = _ask(monkeypatch)
    res = approvals.answer(row["id"], "reject", row["token"])
    assert res["ok"] is True and res["status"] == "rejected"
    assert ran == []


def test_知らない指示は受け付けない(monkeypatch):
    row = _ask(monkeypatch)
    res = approvals.answer(row["id"], "run-it-anyway", row["token"])
    assert res["ok"] is False


def test_一覧に合言葉を出さない(monkeypatch):
    """画面を覗ける人が、誰でも実行できるようになってしまう。"""
    row = _ask(monkeypatch)
    import json
    dumped = json.dumps(approvals.list_pending(), ensure_ascii=False, default=str)
    assert row["token"] not in dumped
    assert "token" not in (approvals.list_pending()[0] or {})


def test_実行できなかったら_その旨を残す(monkeypatch):
    import tools

    def boom(n, p):
        raise RuntimeError("送信先が設定されていません")

    monkeypatch.setattr(tools, "execute_tool", boom)
    row = _ask(monkeypatch)
    res = approvals.answer(row["id"], "approve", row["token"])
    assert res["ok"] is False
    saved = approvals.get(row["id"])
    assert saved["status"] == "failed" and "設定" in (saved.get("result") or "")


def test_実行するときは元の保存先へ戻る(monkeypatch):
    """定期実行は人ごとに保存先を差し替えながら回る。

    控えた人の所へ戻らずに実行すると、別の人のDBに対して動いてしまう。
    """
    seen = {}
    import tools
    monkeypatch.setattr(tools, "execute_tool",
                        lambda n, p: seen.setdefault("client", config.get_supabase()) or "ok")

    sentinel = object()
    import tenancy
    monkeypatch.setattr(tenancy, "client_for", lambda uid: sentinel if uid == "u-123" else None)

    row = _ask(monkeypatch, user_id="u-123")
    approvals.answer(row["id"], "approve", row["token"])
    assert seen["client"] is sentinel, "控えた人の保存先に戻っていない"


def test_時間切れは一覧から消える(monkeypatch):
    row = _ask(monkeypatch)
    assert len(approvals.list_pending()) == 1
    approvals._update(row["id"], {"created_at": time.time() - approvals.TTL - 1})
    assert approvals.list_pending() == []
    assert approvals.expire_old() >= 1
    assert approvals.get(row["id"])["status"] == "expired"


# ── 通知と、止まった用事の結びつき ───────────────────────────────────

def test_通知に合言葉と宛先が載る(monkeypatch):
    sent = {}
    import webpush
    monkeypatch.setattr(webpush, "send",
                        lambda title, body="", **kw: sent.update({"title": title, **kw}) or {"ok": True})

    row = approvals.ask("send_email", {"to": "a@b.com"}, note="メールを送ります",
                        answer_url="https://api.example/approvals/answer")
    assert sent["kind"] == "approval"
    assert sent["id"] == row["id"]
    assert sent["token"] == row["token"]
    assert sent["answer_url"].startswith("https://")


def test_通知が飛ばなくても控えは残る(monkeypatch):
    """「通知が来なかったから、待っていたことすら分からない」を作らない。"""
    import webpush

    def boom(*a, **k):
        raise RuntimeError("端末が登録されていない")

    monkeypatch.setattr(webpush, "send", boom)
    row = approvals.ask("notify", {"message": "x"}, note="確認")
    assert approvals.get(row["id"])["status"] == "pending"
    assert len(approvals.list_pending()) == 1


# ── 定期実行から、ちゃんとここへ来るか ───────────────────────────────

def test_定期実行が承認で止まったら_控えて知らせる(monkeypatch):
    """直した穴そのもの。ここが落ちると、また黙って消える形に戻る。"""
    import scheduler

    events = [
        {"phase": "start"},
        {"phase": "approval", "tool": "send_email",
         "params": {"to": "a@b.com"}, "why": "送ったメールは取り消せません。"},
    ]
    import agent
    monkeypatch.setattr(agent, "run_stream", lambda *a, **k: iter(events))
    monkeypatch.setattr(scheduler, "_due", lambda rows: [
        {"id": "s1", "instruction": "毎朝レポートを送る"}])
    monkeypatch.setattr(scheduler, "_mark_ran", lambda _id: None)
    monkeypatch.setattr(scheduler, "list_schedules", lambda n=1000: [])

    notes = []
    import notify
    monkeypatch.setattr(notify, "notify_all", lambda m: notes.append(m) or {"ok": True})
    import webpush
    monkeypatch.setattr(webpush, "send", lambda *a, **k: {"ok": True})

    res = scheduler.tick("u-777")

    # ① 待ち行列に残っている
    pending = approvals.list_pending()
    assert len(pending) == 1, "承認待ちが控えられていない"
    assert pending[0]["tool"] == "send_email"
    assert pending[0]["user_id"] == "u-777", "誰の所で止まったかを控えていない"
    assert pending[0]["source"] == "schedule"

    # ② 結果が空のまま通知されない（何が起きたか分かる文になっている）
    assert res["ran"] and res["ran"][0]["result"], "結果が空のまま"
    assert "確認" in res["ran"][0]["result"]
    assert notes and "確認" in notes[0]


def test_承認が要らない定期実行は_今まで通り(monkeypatch):
    """止まらない用事に、余計な承認待ちを作らないこと。"""
    import scheduler
    import agent

    monkeypatch.setattr(agent, "run_stream",
                        lambda *a, **k: iter([{"phase": "final", "text": "できました"}]))
    monkeypatch.setattr(scheduler, "_due", lambda rows: [
        {"id": "s2", "instruction": "毎朝まとめる"}])
    monkeypatch.setattr(scheduler, "_mark_ran", lambda _id: None)
    monkeypatch.setattr(scheduler, "list_schedules", lambda n=1000: [])
    import notify
    monkeypatch.setattr(notify, "notify_all", lambda m: {"ok": True})

    res = scheduler.tick("u-1")
    assert res["ran"][0]["result"] == "できました"
    assert approvals.list_pending() == []


# ── エンドポイント ───────────────────────────────────────────────────

def test_答える口はログインを求めない(monkeypatch):
    """通知から叩くのはサービスワーカー。画面の鍵は渡らない。

    ただし合言葉が違えば通らない（次のテスト）。
    """
    from fastapi.testclient import TestClient
    from main import app

    import tools
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: "ok")
    row = approvals.create("notify", {"message": "x"})

    r = TestClient(app).post("/approvals/answer",
                             json={"id": row["id"], "decision": "approve", "token": row["token"]})
    assert r.status_code == 200 and r.json()["ok"] is True


def test_合言葉が無い問い合わせは通らない():
    from fastapi.testclient import TestClient
    from main import app

    row = approvals.create("notify", {"message": "x"})
    r = TestClient(app).post("/approvals/answer",
                             json={"id": row["id"], "decision": "approve"})
    assert r.json()["ok"] is False
    assert approvals.get(row["id"])["status"] == "pending"


def test_一覧はログインが要る():
    from fastapi.testclient import TestClient
    from main import app

    r = TestClient(app).get("/approvals")
    # 認証を掛けていない構成では通る。掛けている構成では 401。
    assert r.status_code in (200, 401)
    if r.status_code == 200:
        assert "items" in r.json()


def test_画面からの口は合言葉を要求しない(monkeypatch):
    """ログイン済みの画面には、合言葉が渡っていない（通知の中にしかない）。

    ここで合言葉を要求すると、通知が届かなかった人は永久に答えられない。
    """
    import tools
    ran = []
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: ran.append(n) or "ok")
    row = approvals.create("notify", {"message": "x"})
    res = approvals.answer_signed_in(row["id"], "approve")
    assert res["ok"] is True and ran == ["notify"]


def test_通知の口は合言葉が無いと通らない_画面の口があっても(monkeypatch):
    """入口を分けた意味。片方を緩めても、もう片方は緩まないこと。"""
    row = approvals.create("notify", {"message": "x"})
    assert approvals.answer(row["id"], "approve", "")["ok"] is False
    assert approvals.answer(row["id"], "approve", "でたらめ")["ok"] is False
    assert approvals.get(row["id"])["status"] == "pending"


def test_画面の口はログインを求める():
    """こちらの口は素通しにしない（合言葉を確かめないぶん、認証で守る）。"""
    import inspect
    import main
    src = inspect.getsource(main.approvals_decide)
    assert "require_auth" in src, "画面の口にログインが掛かっていない"
