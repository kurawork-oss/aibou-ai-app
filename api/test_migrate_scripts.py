"""
DBの土台が、本当に作られるかの検証。

ここが崩れると何が起きるか
--------------------------
どちらも**黙って効かなくなる**種類の不具合だった。

  ・supabase/migrations/ を流していなかった
    → pgvector と match_memories RPC がどのDBにも作られない。
      memory_store はその両方を使う前提で書いてあるので、意味検索は
      「実装されているのに一度も動いたことがない」状態だった。
      手で Supabase CLI を叩いた人だけ動いていた。

  ・全部を1回の execute に渡していた
    → `create extension vector` の権限が無いDBでは、その1文で落ちて
      **残りの表も作られない**。しかも戻り値は error だけで、どこまで
      流れたのかが分からない。

  ・embedding 列が無いDBで記憶を1件も保存できなかった
    → insert に embedding を含めるので、列が無ければ失敗し、
      記憶そのものが残らない。意味検索はあれば嬉しい追加機能なのに、
      それが無いせいで本体が死んでいた。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import memory_store
import migrate


# ── 流すSQL ────────────────────────────────────────────────────────

def test_本体のスキーマと追加のSQLを両方流す():
    names = [n for n, _ in migrate.migration_scripts()]
    assert "supabase_schema.sql" in names, "本体のスキーマが流れていない"
    assert any(n.endswith(".sql") and n != "supabase_schema.sql" for n in names), \
        "supabase/migrations/ が流れていない（pgvectorがどのDBにも作られない）"


def test_意味検索の土台が含まれている():
    """memory_store が使う物が、実際に作られる側にあるか。

    使う側と作る側が離れていると、片方だけ直して気づけない。
    """
    body = "\n".join(b for _, b in migrate.migration_scripts())
    assert "match_memories" in body, "RPC を作るSQLが無い（mem_recall の意味検索が動かない）"
    assert "embedding vector(768)" in body, "embedding 列を作るSQLが無い（mem_add が失敗する）"
    assert "extension if not exists vector" in body, "pgvector 拡張の作成が無い"


def test_本体のスキーマが先に流れる():
    # agent_memory を作る前に alter しようとすると失敗する
    names = [n for n, _ in migrate.migration_scripts()]
    assert names[0] == "supabase_schema.sql"


def test_追加のSQLは名前順に流れる():
    extra = [n for n, _ in migrate.migration_scripts() if n != "supabase_schema.sql"]
    assert extra == sorted(extra), "順番が決まっていないと、依存のある変更が壊れる"


class FakeCursor:
    def __init__(self, fail_on):
        self.fail_on = fail_on
        self.ran = []

    def __enter__(self): return self
    def __exit__(self, *a): return False

    def execute(self, sql):
        for bad in self.fail_on:
            if bad in sql:
                raise RuntimeError(f"permission denied for {bad}")
        self.ran.append(sql[:40])


class FakeConn:
    def __init__(self, fail_on=()):
        self.autocommit = False
        self.cur = FakeCursor(fail_on)
        self.closed = False

    def cursor(self): return self.cur
    def close(self): self.closed = True


@pytest.fixture
def fake_pg(monkeypatch):
    """psycopg2 を差し替える。1本ずつ流れているかを数える。"""
    holder = {}

    def make(fail_on=()):
        conn = FakeConn(fail_on)
        holder["conn"] = conn

        class FakePsycopg2:
            @staticmethod
            def connect(url, connect_timeout=0):
                return conn

        monkeypatch.setitem(sys.modules, "psycopg2", FakePsycopg2)
        monkeypatch.setattr(migrate, "db_url", lambda: "postgresql://x/y")
        return conn

    make.holder = holder
    return make


def test_1本が落ちても_残りは流れる(fake_pg):
    """`create extension vector` の権限が無いDBで、表まで作られないのを防ぐ。"""
    conn = fake_pg(fail_on=("extension if not exists vector",))
    out = migrate.run_migrations()

    assert len(out["ran"]) >= 1, "1本落ちたら全部止まっている"
    assert out["failed"], "落ちたことが報告されていない"
    assert "vector" in out["failed"][0]["script"] or "vector" in out["failed"][0]["error"]


def test_落ちた物があれば_okを立てない(fake_pg):
    """「流しました」と言って半分しか流れていないのが、いちばん困る。"""
    fake_pg(fail_on=("match_memories",))
    out = migrate.run_migrations()
    assert out["ok"] is False
    assert out["failed"], "何が落ちたのか分からない"


def test_全部流れたら_名前が全部返る(fake_pg):
    fake_pg()
    out = migrate.run_migrations()
    assert out["ok"] is True
    assert not out["failed"]
    assert len(out["ran"]) == len(migrate.migration_scripts())


def test_接続文字列が無ければ_理由を返す(monkeypatch):
    monkeypatch.setattr(migrate, "db_url", lambda: "")
    out = migrate.run_migrations()
    assert out["ok"] is False
    assert out.get("skipped") is True
    assert "SUPABASE_DB_URL" in out["reason"]


# ── embedding 列が無いDBでも、記憶は残ること ───────────────────────

class MemQuery:
    def __init__(self, client):
        self._c = client

    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def is_(self, *a, **k): return self
    def order(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def execute(self):
        return type("R", (), {"data": list(self._c.rows)})()

    def insert(self, row):
        self._c.attempts.append(dict(row))
        c = self._c

        class Ins:
            def execute(_s):
                if "embedding" in row and not c.has_vector:
                    raise RuntimeError(
                        'column "embedding" of relation "agent_memory" does not exist')
                c.rows.append(dict(row))
        return Ins()


class MemClient:
    def __init__(self, has_vector):
        self.has_vector = has_vector
        self.rows = []
        self.attempts = []

    def table(self, _n): return MemQuery(self)
    def rpc(self, *a, **k): raise RuntimeError("no rpc")


def test_pgvectorが無いDBでも_記憶は保存される(monkeypatch):
    """ここを諦めていた間、そのDBの人の記憶は**1件も入らなかった**。"""
    c = MemClient(has_vector=False)
    monkeypatch.setattr(memory_store, "get_supabase", lambda: c)
    monkeypatch.setattr(memory_store, "embed", lambda _t: [0.1] * 768)

    assert memory_store.mem_add("fact", "甲殻類アレルギーがある", importance=2) is True
    saved = [r for r in c.rows if r.get("content") == "甲殻類アレルギーがある"]
    assert saved, "記憶が保存されていない"
    assert "embedding" not in saved[0], "無い列を書こうとしている"


def test_pgvectorがあるDBでは_ベクトルも保存する(monkeypatch):
    c = MemClient(has_vector=True)
    monkeypatch.setattr(memory_store, "get_supabase", lambda: c)
    monkeypatch.setattr(memory_store, "embed", lambda _t: [0.1] * 768)

    assert memory_store.mem_add("fact", "朝は7時に起きる") is True
    assert "embedding" in c.rows[0], "意味検索のためのベクトルが入っていない"


def test_一度失敗したら_次からベクトル化を試さない(monkeypatch):
    """Geminiへの往復は待ち時間になる。読む相手がいないなら呼ばない。"""
    calls = {"n": 0}

    def counting_embed(_t):
        calls["n"] += 1
        return [0.1] * 768

    c = MemClient(has_vector=False)
    monkeypatch.setattr(memory_store, "get_supabase", lambda: c)
    monkeypatch.setattr(memory_store, "embed", counting_embed)

    memory_store.mem_add("fact", "1つめ")
    first = calls["n"]
    memory_store.mem_add("fact", "2つめ")
    memory_store.mem_add("fact", "3つめ")
    assert calls["n"] == first, "無駄なベクトル化を繰り返している"
    assert len(c.rows) == 3, "2件目以降が保存されていない"
