# test_rules.py — 人が書いたメモを、AIbouに守らせる
#
# やりたかったこと:
#   Obsidianで「Xに投稿するときは絵文字を使わない」と書いておくと、
#   AIbouが投稿する前にそれを読んで従う。人がメモを直せば振る舞いが変わる。
#
# ここで固定しておきたいのは3つ。
#
#   1. 会話のたびにGitHubを読みに行かないこと。
#      読みに行くと、その往復がそのまま返事の待ち時間になる。
#      取りに行くのは「同期したとき」だけで、ふだんは保存済みから読む。
#
#   2. ツール別のルールが、実行の前に読まれること。
#      投稿や送信は取り返しがつかない。実行してから読んでも遅い。
#
#   3. AIbouがルールを書き換えられないこと。
#      書き換えられると、AIが自分に都合のいい決まりを作れてしまう。

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent
import config
import llm
import rules
import tools


class FakeDB:
    """agent_rules の表だけを持つ、最小の偽Supabase。"""

    def __init__(self):
        self.rows = []
        self.reads = 0

    def table(self, name):
        assert name == "agent_rules"
        return _Q(self)


class _Q:
    def __init__(self, db):
        self.db, self._op, self._rows = db, "select", None

    def select(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def neq(self, *a, **k): return self
    def insert(self, rows): self._op, self._rows = "insert", rows; return self
    def delete(self): self._op = "delete"; return self

    def execute(self):
        if self._op == "insert":
            self.db.rows.extend(self._rows if isinstance(self._rows, list) else [self._rows])
            return type("R", (), {"data": list(self.db.rows)})()
        if self._op == "delete":
            self.db.rows = []
            return type("R", (), {"data": []})()
        self.db.reads += 1
        return type("R", (), {"data": [dict(r) for r in self.db.rows]})()


@pytest.fixture(autouse=True)
def clean():
    rules._mem_rules.clear()
    yield
    rules._mem_rules.clear()


def _bound(client):
    class _C:
        def __enter__(s): s.t = config.bind_request_client(client); return client
        def __exit__(s, *a): config.reset_request_client(s.t)
    return _C()


# ── メモの読み取り ────────────────────────────────────────────────

def test_a_note_with_japanese_front_matter_becomes_a_tool_rule():
    r = rules.parse("ルール/Xへの投稿.md", """---
適用: ツール
対象: x_post, notify
---
- 絵文字は使わない
- 140字を超えたら削る
""")
    assert r["applies"] == "tool"
    assert r["targets"] == "x_post,notify"
    assert r["title"] == "Xへの投稿"
    assert "絵文字は使わない" in r["body"]


def test_a_note_without_front_matter_is_always_on():
    r = rules.parse("メモ.md", "丁寧語で話す")
    assert r["applies"] == "always"
    assert r["body"] == "丁寧語で話す"


def test_a_scoped_note_with_no_target_falls_back_to_always():
    """「ツール」と書いたのに対象が空だと、誰にも当たらず黙って消える。
    それでは書いた人が気づけないので、常時として扱う。"""
    r = rules.parse("x.md", "---\n適用: ツール\n---\n短く書く")
    assert r["applies"] == "always"


def test_an_empty_note_is_skipped():
    assert rules.parse("空.md", "---\n適用: 常時\n---\n\n") is None


# ── 会話のたびにGitHubへ行かないこと ──────────────────────────────

def test_reading_rules_never_touches_github(monkeypatch):
    """ここが崩れると、返事のたびに1秒近く増える。"""
    import gh

    def _boom(*a, **k):
        raise AssertionError("読み出しでGitHubを叩いている")

    monkeypatch.setattr(gh, "import_repo", _boom)
    db = FakeDB()
    with _bound(db):
        rules.replace_all([rules.parse("a.md", "常に丁寧に")])
        assert "常に丁寧に" in rules.always_block()
        assert rules.for_tool("x_post") == ""


def test_repeated_reads_hit_the_database_only_once(monkeypatch):
    """1リクエストのうちに何度も読み直さない（覚えておく）。"""
    db = FakeDB()
    with _bound(db):
        rules.replace_all([rules.parse("a.md", "常に丁寧に")])
        db.reads = 0
        for _ in range(5):
            rules.always_block()
        assert db.reads <= 1, f"{db.reads}回もDBを読んでいる"


def test_sync_is_the_only_place_that_reads_github(monkeypatch):
    import gh
    import keychain

    monkeypatch.setattr(keychain, "get_key",
                        lambda n: {"RULES_REPO": "me/notes", "RULES_PATH": ""}.get(n, ""))
    monkeypatch.setattr(gh, "import_repo", lambda repo, path="": {
        "repo": repo, "ref": "main", "skipped": 0,
        "files": [
            {"path": "ルール/Xへの投稿.md",
             "content": "---\n適用: ツール\n対象: x_post\n---\n絵文字は使わない"},
            {"path": "ルール/口調.md", "content": "丁寧語で話す"},
            {"path": "README.md", "content": "# これはメモではない"},
            {"path": "画像.png", "content": "..."},          # .md 以外は無視
        ],
    })
    db = FakeDB()
    with _bound(db):
        res = rules.sync()
        assert res["count"] == 3, res
        assert res["by_applies"]["tool"] == 1
        assert "絵文字は使わない" in rules.for_tool("x_post")
        assert "丁寧語で話す" in rules.always_block()


def test_sync_replaces_instead_of_piling_up(monkeypatch):
    """メモを消したのにルールが残り続けると、直せなくなる。"""
    import gh
    import keychain
    monkeypatch.setattr(keychain, "get_key", lambda n: "me/notes" if n == "RULES_REPO" else "")

    db = FakeDB()
    with _bound(db):
        monkeypatch.setattr(gh, "import_repo", lambda repo, path="": {
            "files": [{"path": "a.md", "content": "古いルール"}]})
        rules.sync()
        assert "古いルール" in rules.always_block()

        monkeypatch.setattr(gh, "import_repo", lambda repo, path="": {
            "files": [{"path": "b.md", "content": "新しいルール"}]})
        rules.sync()
        block = rules.always_block()
        assert "新しいルール" in block
        assert "古いルール" not in block


# ── 常時ぶんが膨らみすぎないこと ──────────────────────────────────

def test_always_rules_are_capped(monkeypatch):
    """全部を常に入れると、肝心の質問が薄まる。"""
    db = FakeDB()
    with _bound(db):
        rules.replace_all([rules.parse(f"{i}.md", "あ" * 1500) for i in range(10)])
        block = rules.always_block()
        assert len(block) < rules.ALWAYS_BUDGET + 500
        assert "省略" in block, "切ったことが伝わらない"


# ── ツール別ルールが、実行の前に読まれること ──────────────────────

def test_a_tool_rule_is_shown_before_the_tool_runs(monkeypatch):
    """実行してからルールを読んでも遅い。呼ぶ前に一度読ませて、直させること。

    使う道具を board_add_note にしてあるのは、notify のような「取り返せない」
    道具は必ず確認に回る（そこで止まる）ようになったため。ここで見たいのは
    ルールの差し戻しなので、確認に回らない段階の道具で確かめる。
    """
    calls = {"n": 0, "executed": []}

    def _gen(prompt, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return tools.TOOL_CALL_MARKER + '{"tool":"board_add_note","params":{"text":"やあ🎉"}}'
        if calls["n"] == 2:
            # ルールを読んだあとの呼び直し
            assert "絵文字は使わない" in prompt, "ルールが渡っていない"
            return tools.TOOL_CALL_MARKER + '{"tool":"board_add_note","params":{"text":"やあ"}}'
        return "貼りました。"

    monkeypatch.setattr(llm, "generate_text", _gen)
    monkeypatch.setattr(tools, "execute_tool",
                        lambda n, p: calls["executed"].append(p.get("text")) or "貼りました")

    db = FakeDB()
    with _bound(db):
        rules.replace_all([rules.parse("n.md",
            "---\n適用: ツール\n対象: board_add_note\n---\n絵文字は使わない")])
        evs = list(agent.run_stream("付箋を貼って"))

    assert calls["executed"] == ["やあ"], "ルールを読む前に実行してしまっている"
    prep = [e for e in evs if e["phase"] == "prepare" and "ルール" in (e.get("what") or "")]
    assert prep, "ルールを読んだことが画面に出ていない"


def test_the_same_rule_is_not_shown_twice(monkeypatch):
    """同じルールを出し続けると、同じ所を回り続けて終わらない。"""
    calls = {"n": 0}

    def _gen(prompt, **kw):
        calls["n"] += 1
        if calls["n"] <= 3:
            return tools.TOOL_CALL_MARKER + '{"tool":"notify","params":{"message":"やあ"}}'
        return "終わりました。"

    monkeypatch.setattr(llm, "generate_text", _gen)
    monkeypatch.setattr(tools, "execute_tool", lambda n, p: "送信しました")

    db = FakeDB()
    with _bound(db):
        rules.replace_all([rules.parse("n.md",
            "---\n適用: ツール\n対象: notify\n---\n絵文字は使わない")])
        evs = list(agent.run_stream("通知して"))

    shown = [e for e in evs if e["phase"] == "prepare" and "notify" in (e.get("what") or "")]
    assert len(shown) == 1, f"ルールを{len(shown)}回出している"
    assert evs[-1]["phase"] == "done"


def test_the_agent_still_works_when_rules_cannot_be_read(monkeypatch):
    """ルールは無くても動くべきもの。読めなくても止めない。

    保存先が落ちている・表がまだ無い、はふつうに起きる。そのときに
    エージェントごと動かなくなるのでは、足を引っ張っているだけになる。
    """
    def _boom(*a, **k):
        raise RuntimeError("保存先が落ちている")

    # 読み出しの実体を壊す（agent 側の逃がしが効いているかを見る）
    monkeypatch.setattr(rules, "always_block", _boom)
    monkeypatch.setattr(rules, "for_topic", _boom)
    monkeypatch.setattr(rules, "for_tool", _boom)
    monkeypatch.setattr(llm, "generate_text", lambda p, **k: "はい。")

    try:
        evs = list(agent.run_stream("こんにちは"))
    except Exception as e:
        pytest.fail(f"ルールが読めないだけで止まった: {e}")
    assert evs[-1]["phase"] == "done"
    assert any(e["phase"] == "final" for e in evs), "返事そのものが出ていない"


# ── AIbouがルールを書き換えられないこと ──────────────────────────

def test_the_agent_has_no_tool_for_writing_rules():
    """書き換えられると、AIが自分に都合のいい決まりを作れてしまう。"""
    names = set(tools._DISPATCH.keys())
    assert not [n for n in names if "rule" in n.lower()], f"ルールを書けるツールがある: {names}"
    assert "rules" not in tools.TOOLS_DOC.lower()
