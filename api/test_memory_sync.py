"""
端末の記憶とサーバーの記憶を合流させる所の検証。

ここが崩れると何が起きるか
--------------------------
合流の不具合は、**その場では見えない**という共通点がある。

  ・上がっていない   → 機種変した日に、全部消えていたと気づく
  ::               （その時点では、もう元のデータが無い）
  ・降りてこない     → 2台目がいつまでも空。故障には見えない
  ・古い版が勝つ     → 直したはずの記憶が、翌日だまって戻っている
  ・墓標が運ばれない → 「忘れて」と言ったことが、別の端末から復活する

どれも「なんとなく賢くない」としか見えないので、誰も不具合として報告
しない。だから実例で固定する。
"""

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import memory_store
import memory_sync


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=timezone.utc)
OLD = NOW - timedelta(days=3)
NEWER = NOW + timedelta(minutes=5)


# ── Supabase の代わり ───────────────────────────────────────────────
# 本物と同じように**絞り込みを効かせる**偽物。ここを「全部返す」にすると、
# 絞り込みを書き忘れたバグをテストが素通しする（会話ログまで端末へ降ろす、
# 消した記憶を返す、など）。

class FakeQuery:
    def __init__(self, client, missing_cols=()):
        self._c = client
        self._missing = set(missing_cols)
        self._rows = list(client.rows)
        self._limit = None
        self._desc = False
        self._order = None

    def _check(self, col):
        """古いDBを再現する。無い列に触れたら、本物と同じように失敗する。"""
        if col in self._missing:
            raise RuntimeError(f'column agent_memory.{col} does not exist')

    def select(self, cols="*"):
        for c in str(cols).split(","):
            self._check(c.strip())
        return self

    def eq(self, col, val):
        self._check(col)
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def in_(self, col, vals):
        self._check(col)
        self._rows = [r for r in self._rows if r.get(col) in vals]
        return self

    def gt(self, col, val):
        self._check(col)
        self._rows = [r for r in self._rows
                      if memory_sync._ms(r.get(col)) > memory_sync._ms(val)]
        return self

    def is_(self, col, what):
        self._check(col)
        assert what == "null"
        self._rows = [r for r in self._rows if not r.get(col)]
        return self

    def order(self, col, desc=False):
        self._check(col)
        self._order, self._desc = col, desc
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = self._rows
        if self._order:
            rows = sorted(rows, key=lambda r: memory_sync._ms(r.get(self._order)),
                          reverse=self._desc)
        if self._limit is not None:
            rows = rows[: self._limit]
        self._c.reads += 1
        return type("R", (), {"data": [dict(r) for r in rows]})()

    # 書き込み側
    def upsert(self, rows, on_conflict=None):
        for row in rows:
            for col in row:
                self._check(col)
        self._c.pending_upsert = rows
        return self

    def insert(self, row):
        self._c.pending_insert = row
        return self


class FakeClient:
    def __init__(self, rows=None, missing_cols=()):
        self.rows = list(rows or [])
        self.missing = set(missing_cols)
        self.reads = 0
        self.pending_upsert = None
        self.pending_insert = None

    def table(self, _name):
        q = FakeQuery(self, self.missing)
        # upsert/insert は execute() で確定させる
        orig = q.execute

        def execute():
            if self.pending_upsert is not None:
                for row in self.pending_upsert:
                    self.rows = [r for r in self.rows if r.get("id") != row.get("id")]
                    self.rows.append(dict(row))
                self.pending_upsert = None
                return type("R", (), {"data": []})()
            if self.pending_insert is not None:
                self.rows.append(dict(self.pending_insert))
                self.pending_insert = None
                return type("R", (), {"data": []})()
            return orig()

        q.execute = execute
        return q

    def rpc(self, *_a, **_k):
        raise RuntimeError("no rpc in this test")


@pytest.fixture
def db(monkeypatch):
    """その場かぎりの保存先を差し込む（ほかのテストへ漏らさない）。"""
    def make(rows=None, missing_cols=()):
        c = FakeClient(rows, missing_cols)
        monkeypatch.setattr(config, "get_supabase", lambda: c)
        monkeypatch.setattr(memory_sync, "get_supabase", lambda: c)
        monkeypatch.setattr(memory_store, "get_supabase", lambda: c)
        return c
    return make


def row(ident, content, role="note", updated=NOW, created=None, deleted=None, importance=0):
    return {
        "id": ident, "user_id": "local", "role": role, "content": content,
        "importance": importance,
        "created_at": iso(created or updated), "updated_at": iso(updated),
        "deleted_at": iso(deleted) if deleted else None,
    }


def item(ident, text, kind="note", updated=NOW, created=None, deleted=None, importance=0):
    """端末（memory.ts）が送ってくる形。"""
    ms = lambda d: int(d.timestamp() * 1000)
    out = {"id": ident, "text": text, "kind": kind, "importance": importance,
           "createdAt": ms(created or updated), "updatedAt": ms(updated)}
    if deleted:
        out["deletedAt"] = ms(deleted)
    return out


# ── 上がること ─────────────────────────────────────────────────────

def test_端末の記憶がサーバーへ上がる(db):
    """これまで端末の記憶は1件も上がっていなかった。機種変で全部消える。"""
    c = db([])
    out = memory_sync.sync(0, [item("a1", "甲殻類アレルギーがある", kind="fact", importance=2)])

    assert out["ok"] is True
    assert out["pushed"] == 1
    saved = [r for r in c.rows if r["id"] == "a1"]
    assert saved, "上がっていない"
    assert saved[0]["content"] == "甲殻類アレルギーがある"
    assert saved[0]["role"] == "fact"
    assert saved[0]["importance"] == 2


def test_端末が作ったidをそのまま使う(db):
    # 対応表を持たない設計。ここがずれると、同じ記憶が2件に増える
    c = db([])
    memory_sync.sync(0, [item("11111111-2222-3333-4444-555555555555", "猫の名前はミケ")])
    assert c.rows[0]["id"] == "11111111-2222-3333-4444-555555555555"

    # 2回送っても増えない
    memory_sync.sync(0, [item("11111111-2222-3333-4444-555555555555", "猫の名前はミケ",
                              updated=NEWER)])
    assert len([r for r in c.rows if "ミケ" in (r["content"] or "")]) == 1


# ── 降りてくること ─────────────────────────────────────────────────

def test_サーバーの記憶が端末へ降りる(db):
    """2台目の端末が空のままにならないための一本。"""
    db([row("s1", "毎週火曜15時に打ち合わせ", role="fact")])
    out = memory_sync.sync(0, [])

    assert out["pulled"] == 1
    assert out["items"][0]["text"] == "毎週火曜15時に打ち合わせ"
    assert out["items"][0]["kind"] == "fact"


def test_会話の生ログは降りてこない(db):
    """降ろすと、端末の2000件の枠が数日で会話に埋まる。
    覚えておいてほしいことが押し出されて、記憶として使えなくなる。"""
    db([
        row("u1", "こんにちは", role="user"),
        row("a1", "こんにちは。ご用件は？", role="assistant"),
        row("f1", "朝は7時に起きる", role="fact"),
    ])
    out = memory_sync.sync(0, [])
    got = {i["text"] for i in out["items"]}
    assert got == {"朝は7時に起きる"}, f"降りてきた物: {got}"


def test_前回より後に変わったぶんだけ降りる(db):
    db([row("old", "古い記憶", updated=OLD), row("new", "新しい記憶", updated=NOW)])
    since = int((NOW - timedelta(days=1)).timestamp() * 1000)
    out = memory_sync.sync(since, [])
    assert [i["text"] for i in out["items"]] == ["新しい記憶"]


# ── ぶつかったとき ─────────────────────────────────────────────────

def test_新しいほうが勝つ(db):
    c = db([row("x", "新しい内容", updated=NEWER)])
    out = memory_sync.sync(0, [item("x", "古い内容", updated=OLD)])

    assert out["pushed"] == 0
    assert out["stale"] == 1
    assert [r["content"] for r in c.rows if r["id"] == "x"] == ["新しい内容"], \
        "古い版で上書きされた（直したはずの記憶が翌日戻る形）"


def test_端末のほうが新しければ上書きする(db):
    c = db([row("x", "古い内容", updated=OLD)])
    out = memory_sync.sync(0, [item("x", "直した内容", updated=NOW)])
    assert out["pushed"] == 1
    assert [r["content"] for r in c.rows if r["id"] == "x"] == ["直した内容"]


# ── 消したこと ─────────────────────────────────────────────────────

def test_端末で消すと_サーバー側にも墓標が立つ(db):
    """墓標を運ばないと、次の合流でサーバーから同じ記憶が降りてきて
    **復活する**。「忘れて」が効かないのは、覚えないことより体感が悪い。"""
    c = db([row("d1", "住所は東京都のどこか", updated=OLD)])
    memory_sync.sync(0, [item("d1", "", updated=NOW, deleted=NOW)])

    saved = [r for r in c.rows if r["id"] == "d1"][0]
    assert saved["deleted_at"], "墓標が立っていない"


def test_消した記憶の中身は残さない(db):
    """絞り込みを1か所書き忘れただけで、消したはずの文がAIへ渡る。
    「見せない」ではなく「持たない」。"""
    c = db([row("d1", "秘密の住所", updated=OLD)])
    # 端末が（不具合などで）中身を付けたまま墓標を送ってきても、残さない
    memory_sync.sync(0, [item("d1", "秘密の住所", updated=NOW, deleted=NOW)])

    saved = [r for r in c.rows if r["id"] == "d1"][0]
    assert saved["content"] == "", f"消したのに中身が残っている: {saved['content']!r}"


def test_消した記憶は_もう思い出さない(db):
    """サーバー側の想起から本当に外れているか。ここが抜けていると、
    端末では消えているのにAIだけが覚えている状態になる。"""
    db([
        row("live", "生きている記憶", role="fact"),
        row("dead", "消した記憶", role="fact", deleted=NOW),
    ])
    block = memory_store.mem_recall("記憶", limit=8)
    assert "生きている記憶" in block
    assert "消した記憶" not in block

    recent = memory_store.mem_recent(limit=20)
    assert [r["content"] for r in recent] == ["生きている記憶"]


def test_墓標も端末へ降りる(db):
    # PCで消したことが、スマホにも伝わる必要がある
    db([row("d1", "", role="note", deleted=NOW)])
    out = memory_sync.sync(0, [])
    assert out["items"][0]["deletedAt"] > 0
    assert out["items"][0]["text"] == ""


# ── 黙って成功しないこと ───────────────────────────────────────────

def test_表が古いDBでは_断って理由を出す(db):
    """「同期しました」と出して何も起きていない、が最悪。"""
    db([], missing_cols=("updated_at", "deleted_at"))
    out = memory_sync.sync(0, [item("a", "覚えて")])

    assert out["ok"] is False
    assert out["pushed"] == 0
    assert "supabase_schema" in out["reason"] or "データベース" in out["reason"]


def test_保存先が無ければ_断って理由を出す(monkeypatch):
    monkeypatch.setattr(memory_sync, "get_supabase", lambda: None)
    out = memory_sync.sync(0, [item("a", "覚えて")])
    assert out["ok"] is False
    assert out["reason"]
    assert out["items"] == []


def test_古いDBでも_記憶そのものは空にならない(db):
    """deleted_at が無いDBに絞り込みを投げると問い合わせごと失敗する。
    合流できないのは仕方ないが、そのせいで**記憶が丸ごと消えて見える**のは
    別の話。"""
    db([row("f1", "朝は7時に起きる", role="fact")], missing_cols=("updated_at", "deleted_at"))
    assert "朝は7時に起きる" in memory_store.mem_recall("朝", limit=8)
    assert [r["content"] for r in memory_store.mem_recent(20)] == ["朝は7時に起きる"]


def test_絞り込みを知らない古いクライアントでも空にならない(monkeypatch):
    """列ではなくライブラリのほうが古い場合（is_ を持たない）。

    「絞り込みに失敗したら諦める」と書いていた間は、**ここで記憶がゼロに
    なった**。落ちるなら、落ちる前の状態（全部返す）へ戻るほうがよい。
    """
    class OldQuery(FakeQuery):
        def __getattribute__(self, name):
            if name == "is_":
                raise AttributeError("is_")      # 古い postgrest を再現
            return object.__getattribute__(self, name)

    class OldClient(FakeClient):
        def table(self, _name):
            return OldQuery(self)

    c = OldClient([row("f1", "朝は7時に起きる", role="fact")])
    monkeypatch.setattr(memory_store, "get_supabase", lambda: c)
    assert "朝は7時に起きる" in memory_store.mem_recall("朝", limit=8)


def test_絞り込めないDBだと分かったら二度投げしない(db):
    """記憶の想起は「返事を書き始める前」なので、往復はそのまま待ち時間。
    毎回2回投げると、繋いでいる人全員がそのぶん待つ。"""
    c = db([row("f1", "朝は7時に起きる", role="fact")], missing_cols=("deleted_at",))
    memory_store.mem_recent(20)          # ここで「絞り込めない」と分かる
    before = c.reads
    memory_store.mem_recent(20)
    memory_store.mem_recent(20)
    assert c.reads - before == 2, f"2回の読み取りで {c.reads - before} 回投げている"


# ── 外から来る値 ───────────────────────────────────────────────────

def test_壊れた入力は落とすか_丸める(db):
    c = db([])
    out = memory_sync.sync(0, [
        {"text": "idが無い"},                                   # 落とす
        {"id": "x" * 200, "text": "idが長すぎる"},               # 落とす
        item("ok1", "  "),                                      # 中身が空＝落とす
        item("ok2", "正しい記憶", kind="へんな種類", importance=99),
        "文字列",                                                # 落とす
        None,                                                    # 落とす
    ])
    assert out["pushed"] == 1
    saved = [r for r in c.rows if r["id"] == "ok2"][0]
    assert saved["role"] == "note", "知らない種類が、そのまま入っている"
    assert saved["importance"] == 2, "大事さが上限で止まっていない"


def test_長すぎる記憶は切り詰める(db):
    c = db([])
    memory_sync.sync(0, [item("long", "あ" * 9000)])
    assert len(c.rows[0]["content"]) == memory_sync.MAX_TEXT


def test_一度に運ぶ量に上限がある(db):
    """上限が無いと、はじめての合流で数千件を一度に送ることになる。
    途中で切れたときに、どこまで行ったのかが分からなくなる。"""
    c = db([])
    many = [item(f"m{i}", f"記憶{i}") for i in range(memory_sync.MAX_PUSH + 50)]
    out = memory_sync.sync(0, many)
    assert out["pushed"] == memory_sync.MAX_PUSH


# ── 目印（どこまで運んだか） ───────────────────────────────────────

def test_目印はサーバーの時計で返る(db):
    """端末の時計で進めると、ずれているぶんだけ記憶を取りこぼす。"""
    db([])
    before = memory_sync.now_ms()
    out = memory_sync.sync(0, [])
    after = memory_sync.now_ms()
    assert before <= out["at"] <= after


def test_運びきれないときは_続きから運べる目印を返す(db):
    """ここでサーバーの「いま」を返すと、運びきれなかったぶんを飛ばす
    ——降りてこない記憶が、永久に降りてこなくなる。"""
    rows = [row(f"s{i}", f"記憶{i}", updated=OLD + timedelta(seconds=i))
            for i in range(memory_sync.MAX_PULL + 10)]
    db(rows)
    out = memory_sync.sync(0, [])

    assert out["more"] is True
    assert out["pulled"] == memory_sync.MAX_PULL
    last = out["items"][-1]["updatedAt"]
    assert out["at"] < last, "続きの目印が、いま運んだ物より先に進んでいる"

    # 続きを引くと、残りが取れる
    out2 = memory_sync.sync(out["at"], [])
    got = {i["id"] for i in out["items"]} | {i["id"] for i in out2["items"]}
    assert len(got) == memory_sync.MAX_PULL + 10, "取りこぼしがある"
