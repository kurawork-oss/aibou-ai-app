"""
どの表も、ブラウザから素通りで読めないこと（仕様§14）。

なぜ重いのか
------------
このアプリは、ログインに Supabase Auth を使う構成にできる。その場合
**anon キーがブラウザのJSに入る**（そういう鍵なので、それ自体は正しい）。
誰でも配信されたJSから読み出せる。

    NEXT_PUBLIC_SUPABASE_URL      = https://<ref>.supabase.co
    NEXT_PUBLIC_SUPABASE_ANON_KEY = <誰でも読める>

Supabase は PostgREST を通して、その鍵で表を直接叩ける。止めるのは
**RLS（行レベルセキュリティ）だけ**。RLSを入れていない表は、URLを
知っている人なら誰でも読める。

実測（この確認を書いた時点）:

    supabase_schema.sql が作る表  35
    そのうちRLSが入っていた表      4      ← agent_memory ほか
    素通りで読めた表              31      ← api_keys・conversations・
                                             tasks・inbox_messages …

`api_keys` は暗号化して入れてあるが、それ以外（会話・タスク・受信箱・
覚えていること）は素のまま。

どう塞ぐか
----------
  ・user_id のある表 … 自分の行だけ（auth.uid() = user_id）
  ・user_id の無い表 … **ポリシーを作らない**。RLSを入れてポリシーが
                      無ければ、anon からは1行も見えない。サーバー側は
                      service_role で動いていて RLS を通らないので、
                      アプリの動きは何も変わらない。

ここでは live なDBを立てずに、**SQLの字面**を見る。新しい表を足した人が
RLSを書き忘れたら、ここが落ちる。
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

SCHEMA = os.path.join(_ROOT, "supabase_schema.sql")
MIGRATIONS = os.path.join(_ROOT, "supabase", "migrations")


def _sql() -> str:
    """流されるSQLを、流される順に1つへ繋げる（migrate.migration_scripts と同じ順）。"""
    import migrate
    return "\n".join(body for _name, body in migrate.migration_scripts())


def _tables(sql: str):
    """作られる表の名前。

    名前のうしろに `(` が来ることを条件にしている。付けないと、
    コメントの中の「create table」らしき日本語まで表の名前として拾う
    （実際、最初それで「だけだと」という表があることになった）。
    """
    return set(re.findall(
        r"create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(",
        sql, re.I))


def _rls_on(sql: str):
    """RLSを入れている表。直書きと、do $$ ループの両方を見る。"""
    out = set(re.findall(
        r"alter\s+table\s+(?:public\.)?(\w+)\s+enable\s+row\s+level\s+security", sql, re.I))
    for block in re.findall(r"array\s*\[(.*?)\]", sql, re.S):
        if "enable row level security" in sql[sql.index(block):sql.index(block) + 2000]:
            out |= set(re.findall(r"'(\w+)'", block))
    return out


def test_作る表には_全部RLSが入っている():
    sql = _sql()
    tables = _tables(sql)
    assert len(tables) > 20, f"表が読めていない（この確認が空振りしている）: {len(tables)}"
    missing = sorted(tables - _rls_on(sql))
    assert not missing, (
        "RLSの無い表があります。anonキーはブラウザに配られるので、"
        "ここが抜けていると誰でも読めます:\n  " + "\n  ".join(missing))


def test_user_idのある表は_自分の行だけ():
    """ポリシーが `auth.uid() = user_id` になっていること。

    ここを `true` や `auth.role() = 'authenticated'` にすると、
    ログインした**他人**の行まで見える。

    通してよい形は2つだけ:
      ・auth.uid() = user_id   … 自分の行
      ・public.is_owner()      … 持ち主だけ（利用者管理の画面で要る）

    ファイル置き場（storage.objects）は別扱い。生成した画像をブラウザから
    出すために公開読みにしてあり、置き場は利用者ごとに別プロジェクトなので
    見えるのは自分の物だけ。意図してそうしている所なので、ここでは数えない。
    """
    sql = _sql()
    bad = []
    for m in re.finditer(
            r"create\s+policy\s+\"?([^\"\n]+)\"?\s+on\s+(storage\.objects|(?:public\.)?\w+)(.*?);",
            sql, re.I | re.S):
        table, body = m.group(2), m.group(3)
        if "using" not in body.lower():
            continue
        if table.lower().startswith("storage."):
            continue
        if "auth.uid()" in body or "is_owner()" in body:
            continue
        bad.append(f"{table}: {m.group(1)}")
    assert not bad, "自分の行だけに絞っていないポリシー:\n  " + "\n  ".join(bad)


def test_誰でも通すポリシーを作っていない():
    sql = _sql().lower()
    for danger in ["using (true)", "using(true)", "with check (true)", "with check(true)"]:
        assert danger not in sql, f"全部を通すポリシーがあります: {danger}"


def test_RLSを入れた表は_サーバーからは今まで通り触れる():
    """service_role は RLS を通らない。アプリは全部そちらで動いているので、
    RLSを入れても動きは変わらない——という前提を、ここに書き残しておく。

    前提が崩れる（ブラウザから直に表を読む）変更が入ったら、
    webapp 側の確認（tests/rls.spec.ts）が落ちる。
    """
    import config
    # 保存先はいつも service_role で作る。anon で作る経路が無いこと。
    src = open(os.path.join(_HERE, "config.py"), encoding="utf-8").read()
    assert "SUPABASE_SERVICE_KEY" in src
    assert "ANON" not in src.upper(), "サーバー側が anon キーを使おうとしている"
    assert config is not None


def test_流すSQLの順番が_表より後にRLSを置いている():
    """RLSを先に流しても、表がまだ無ければ何も起きない（黙って素通りする）。"""
    import migrate
    scripts = migrate.migration_scripts()
    names = [n for n, _ in scripts]
    assert names, "流すSQLが1つも見つからない"
    body = "\n".join(b for _n, b in scripts)
    for t in sorted(_tables(body)):
        at_create = body.lower().index(f"table {t}".lower()) if f"table {t}".lower() in body.lower() else None
        if at_create is None:
            continue
        m = re.search(rf"alter\s+table\s+(?:public\.)?{t}\s+enable\s+row\s+level\s+security",
                      body, re.I)
        if m:
            assert m.start() > at_create, f"{t}: 表より前にRLSを入れようとしている"
