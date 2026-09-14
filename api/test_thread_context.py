"""
「その人の保存先」が、道具の動くスレッドまで届くか。

見つけ方
--------
会話でも作った物を出したくて `present.begin()` を足そうとしたとき、
先に置き場そのものを疑った。同時に何人も使ったらどうなるかを実測した。

    利用者6人ぶんを同時に走らせる
      → 1人ぶんの実行が **3〜5本のスレッドをまたいだ**
      → 回収36回のうち25回が空、**15回は他人の物が出た**

何が起きているか
----------------
`present` も「その人のDB」も ContextVar で分けている。ContextVar は
**スレッドごと**に中身を持つ。ところがこのアプリは、重い処理を全部

    await loop.run_in_executor(None, ...)      # main.py に180か所

でワーカースレッドへ逃がしている。`run_in_executor` は呼び出し元の文脈を
**運ばない**（`asyncio.to_thread` や Starlette の `run_in_threadpool` は運ぶ。
`loop.run_in_executor` だけが運ばない）。

そのため道具が動くスレッドでは：

    config.get_supabase()   → 差し替えが見えない → **サーバー既定のDB**
    config.storage_state()  → "memory"（実際は既定DBに書いている）
    present.show(...)       → 箱が無い → 黙って捨てる／他人の箱に入る

いちばん重いのは1つめ。`use_own_database` は
「未接続の人のデータを管理者の共有DBへ黙って書かない」ために None を
差し込んでいるのに、その差し込みが道具まで届いていない。つまり
**繋いでいない人の書き込みが、持ち主のDBへ入る**。

これまでのテストが通っていた理由
--------------------------------
tenancy 系のテストはどれも `bind_request_client()` のあと、その場で
同じスレッドから関数を呼んでいた。**スレッドをまたぐ所だけが試されて
いなかった**。ここはその一段だけを見る。
"""

import asyncio
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import present


class MyDb:
    """その人のDB。中身は要らない（同一性だけ見る）。"""


def run(coro):
    async def _wrap():
        config.install_context_executor()
        return await coro()
    return asyncio.new_event_loop().run_until_complete(_wrap())


# ── その人の保存先が、道具の動くスレッドまで届く ──────────────────

def test_その人のDBが_道具の動くスレッドまで届く():
    mine = MyDb()

    async def _go():
        loop = asyncio.get_event_loop()
        token = config.bind_request_client(mine)
        try:
            return await loop.run_in_executor(None, config.get_supabase)
        finally:
            config.reset_request_client(token)

    assert run(_go) is mine, "道具の側では、その人のDBが見えていない"


def test_保存先の無い人の書き込みが_持ち主のDBへ行かない(monkeypatch):
    """`use_own_database` が None を差し込むのは、まさにこれを防ぐため。

    ここで既定のDBを**在る物として**置くのが肝心。このリポジトリのテストは
    SUPABASE_SERVICE_KEY が無い状態で走るので、既定DBは放っておくと None
    になる。そのまま「None であること」を確かめても、差し替えが届いていても
    いなくても通ってしまう（最初この形で書いていて、壊した状態でも通った）。
    """
    owner = MyDb()      # 持ち主の共有DB。ここへ流れ込んだら事故。
    monkeypatch.setattr(config, "default_supabase", lambda: owner)

    async def _go():
        loop = asyncio.get_event_loop()
        token = config.bind_request_client(None)     # 繋いでいない人
        try:
            return (await loop.run_in_executor(None, config.get_supabase),
                    await loop.run_in_executor(None, config.storage_state))
        finally:
            config.reset_request_client(token)

    db, state = run(_go)
    assert db is not owner, "繋いでいない人の書き込みが、持ち主の共有DBへ流れている"
    assert db is None
    assert state == "memory", f"保存先の申告が食い違っている（{state}）"


def test_スレッドの中で差し替えても_外へ漏れない():
    """運ぶのは写しにする。ワーカーは使い回されるので、そこへ書き残すと
    次にそのスレッドを使った人が拾う。"""
    mine = MyDb()

    async def _go():
        loop = asyncio.get_event_loop()

        def _inside():
            config.bind_request_client(mine)    # わざと後始末しない
            return config.get_supabase()

        await loop.run_in_executor(None, _inside)
        # 同じスレッドが使い回されても、差し替えは残っていないこと
        return await loop.run_in_executor(None, config.get_supabase)

    assert run(_go) is not mine, "ワーカースレッドに前の人の保存先が残っている"


# ── 作った物の置き場 ────────────────────────────────────────────────

def _steps(name, out):
    """道具を使う実行を真似る。1手ごとに yield して、そのたびに
    別のスレッドへ移りうる形にする（agent.run_stream と同じ形）。"""
    token = present.begin()
    try:
        for i in range(4):
            present.show({"kind": "image", "url": f"{name}-{i}"})
            time.sleep(0.005)
            yield "mid"                       # ここでスレッドが変わりうる
            out.append([x["url"] for x in present.take()])
    finally:
        present.end(token)


async def _drive(name, out):
    """main.py が SSE を流すときと同じ回し方。"""
    loop = asyncio.get_event_loop()
    ctx = present.carrier()
    gen = _steps(name, out)

    def _next(g):
        try:
            return ctx.run(next, g)
        except StopIteration:
            return None

    while await loop.run_in_executor(None, _next, gen) is not None:
        pass


def test_何手かかっても_作った物が消えない():
    out: list = []
    asyncio.new_event_loop().run_until_complete(_drive("u0", out))
    assert out == [["u0-0"], ["u0-1"], ["u0-2"], ["u0-3"]], \
        f"途中で落ちている: {out}"


def test_同時に6人使っても_他人の物が出ない():
    """実測ではここで、36回中15回、他人の画像が出ていた。"""
    outs = {f"u{i}": [] for i in range(6)}

    async def _all():
        await asyncio.gather(*[_drive(n, o) for n, o in outs.items()])

    asyncio.new_event_loop().run_until_complete(_all())

    wrong, empty = [], 0
    for me, rows in outs.items():
        for urls in rows:
            if not urls:
                empty += 1
            for u in urls:
                if not u.startswith(me + "-"):
                    wrong.append(f"{me} の画面に {u}")
    assert not wrong, "他人の作った物が出ている:\n" + "\n".join(wrong)
    assert empty == 0, f"作った物が消えた回数: {empty}"


def test_置き場は_リクエストごとに別(  ):
    """carrier() を2つ作ったら、互いに見えないこと。"""
    a, b = present.carrier(), present.carrier()
    a.run(present.show, {"kind": "image", "url": "a"})
    assert [x["url"] for x in a.run(present.peek)] == ["a"]
    assert b.run(present.peek) == []


def test_置き場を作っても_呼んだ側は汚れない():
    """carrier() は写しを持つ。作っただけで、いまの文脈に箱ができては困る
    （その後の素の show() が、どこかに溜まってしまう）。"""
    present.carrier()
    present.show({"kind": "image", "url": "x"})
    assert present.peek() == [], "呼び出し元の文脈に箱が残っている"
