"""
本番の置き場（Render の Docker）に、流すSQLが全部入っているか。

見つけたこと
------------
自動マイグレーション（migrate.py）は、土台（supabase_schema.sql）のあとに
`supabase/migrations/` を名前順に流す。ところが Dockerfile は土台しか
同梱していなかった:

    COPY supabase_schema.sql /app/supabase_schema.sql      ← ある
    （supabase/migrations/ は同梱されていない）            ← 無い

手元とテストではリポジトリの中から探すので見つかり、全部通る。本番だけ
黙って土台しか流れない。流れていなかった物:

    ・どの表にもRLSを入れる移行（ブラウザから表が素通りで読めた穴の本体）
    ・意味検索の土台（pgvector と RPC）
    ・決まった手順の表（browser_recipes）

`/admin/migrate` は「流した物」を返すが、流れなかった物は名前すら出ない
ので、画面からは気づけない。ここで縛る。
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import migrate

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
DOCKERFILE = os.path.join(_HERE, "Dockerfile")


def _copies():
    """Dockerfile の COPY（元 → 先）。"""
    src = open(DOCKERFILE, encoding="utf-8").read()
    return [(a.rstrip("/"), b.rstrip("/"))
            for a, b in re.findall(r"^COPY\s+(\S+)\s+(\S+)\s*$", src, flags=re.M)]


def test_the_migrations_are_shipped_where_migrate_looks():
    shipped = {dst for src, dst in _copies() if src == "supabase/migrations"}
    assert shipped, "supabase/migrations/ が本番の置き場に入っていない"
    assert shipped & set(migrate._MIGRATION_DIRS), (
        f"入れた先 {shipped} を migrate.py が探していない（{migrate._MIGRATION_DIRS}）")


def test_the_base_schema_is_shipped_where_migrate_looks():
    shipped = {dst for src, dst in _copies() if src == "supabase_schema.sql"}
    assert shipped & set(migrate._SCHEMA_CANDIDATES)


def test_every_migration_in_the_repo_would_run():
    """リポジトリにある移行は、1つ残らず流す対象に入っている。"""
    here = sorted(n for n in os.listdir(os.path.join(_ROOT, "supabase", "migrations"))
                  if n.endswith(".sql"))
    names = [n for n, _body in migrate.migration_scripts()]
    for n in here:
        assert n in names, f"{n} が流れない"
