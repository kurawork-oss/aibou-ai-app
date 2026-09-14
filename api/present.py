"""present.py — 道具が作った物を、会話の隣に出すための受け渡し。

なぜ要るか
----------
道具は全部「文字列」を返している。それはAIに読ませるには正しいが、
**人に見せる物としては足りない**。

    画像を作る  →「画像を生成しました：https://… （HOMEの『生成物』
                  からも見られます）」
    資料を作る  →「HOMEの『生成物』からダウンロードできます」
    検索する    → 番号付きの文字列（リンクも押せない）

作っておいて「別の場所へ見に行ってください」と言っている。
頼んだ人が見たいのは、いま作った物そのものであって、住所ではない。

やり方
------
道具の戻り値は変えない（31個ぜんぶ書き換えると、AIに渡る文言まで
巻き添えで変わる）。代わりに**横の口**を作る。作った道具だけが

    present.show({"kind": "image", "url": ..., "title": ...})

と置いていき、そのリクエストの終わりに `take()` で回収する。
置かない道具は今まで通りで、何も壊れない。

リクエストごとに分ける理由
--------------------------
同時に何人も使う。ここをモジュール変数にすると、Aさんが作った画像が
Bさんの画面に出る。ContextVar なら混ざらない（保存先の切り替えと
同じ作り）。

……というのが元の言い分だったが、**実際には混ざっていた。**

ContextVar はスレッドごとに中身を持つ。一方このAPIは、実行を1手ずつ
`loop.run_in_executor(None, next, gen)` で回している。手ごとに別の
ワーカースレッドへ移りうるので、`begin()` したスレッドと `show()` する
スレッドが違えば箱は見つからない。しかもワーカーは使い回されるので、
**前に同じスレッドを使った人の箱**が見つかることがある。

実測（api/test_thread_context.py）: 6人を同時に走らせると、1人ぶんの実行が
3〜5本のスレッドをまたぎ、回収36回のうち25回が空、**15回は他人の物が出た**。

そこで、箱は「スレッドの文脈」ではなく **1つの Context オブジェクト**に
持たせる。`carrier()` がそれを作り、呼ぶ側は毎手それを通す:

    ctx = present.carrier()
    ctx.run(next, gen)        # どのスレッドで動いても、同じ箱を見る

`begin()` / `end()` は、1回の呼び出しで始まって終わる所（承認実行・
`#` の近道・/chat の道具1回）にはそのまま使える——その場合スレッドを
またがないため。またぐ所では `carrier()` を使う。

出さない物
----------
「見せる価値のある物」だけを置く。タスクを1件足した、覚えた、という
出来事は文章で足りる。何でも出すと、キャンバスが会話のログになって、
肝心の物が埋もれる。
"""

from __future__ import annotations

import contextvars
from typing import List, Optional

# 出してよい種類。ここに無い kind は捨てる（画面側が知らない物を
# 渡しても、描けずに空の枠が出るだけなので）。
KINDS = {
    "image",      # url, title
    "document",   # artifact_id, title, content(markdown)
    "slides",     # artifact_id, title, deck
    "table",      # artifact_id, title, content(csv)
    "search",     # query, results[{title,url,snippet}]
    "page",       # url, title, text
    "diagram",    # title, source(mermaid)
    "link",       # url, title  … 外に出来た物（Googleドキュメント等）
}

_items: contextvars.ContextVar = contextvars.ContextVar("present_items", default=None)


def begin() -> object:
    """このリクエストのぶんを開ける。返り値は end() に渡す。"""
    return _items.set([])


def end(token) -> None:
    """閉じる。

    別の文脈で作られたトークンを渡されても、例外にはしない。ここは
    `finally` から呼ばれるので、投げると**見せ方の都合で実行そのものが
    落ちる**。実際、スレッドをまたいだときに
    `ValueError: Token ... was created in a different Context` が出て、
    SSE が途中で切れていた。
    """
    try:
        _items.reset(token)
    except ValueError:
        pass


def carrier():
    """1リクエストぶんの置き場を持った Context を作って返す。

    呼ぶ側は、実行の1手ごとにこれを通す:

        ctx = present.carrier()
        ctx.run(next, gen)

    そうすると、どのワーカースレッドで動いても同じ箱を見る。
    箱は Context の中だけにあるので、呼び出し元の文脈は汚れない
    （作っただけで、その後の素の `show()` が溜まり始めたりしない）。
    """
    ctx = contextvars.copy_context()
    ctx.run(_open)
    return ctx


def _open() -> None:
    _items.set([])


def show(item: dict) -> None:
    """作った物を1つ置く。開いていなければ黙って捨てる。

    黙って捨てるのは、道具が単体テストや別経路から呼ばれることが
    あるため。ここで例外にすると、見せ方の都合で道具が落ちる。
    """
    box = _items.get()
    if box is None or not isinstance(item, dict):
        return
    kind = (item.get("kind") or "").strip()
    if kind not in KINDS:
        return
    box.append(item)


def peek() -> List[dict]:
    box = _items.get()
    return list(box) if box else []


def take() -> List[dict]:
    """置かれた物を回収して、空にする。

    空にするのは、複数手つづくエージェントで同じ物を毎回出さないため。
    1手ごとに take() すれば、その手で出来た物だけが流れる。
    """
    box = _items.get()
    if not box:
        return []
    out = list(box)
    box.clear()
    return out


def first(kind: str) -> Optional[dict]:
    for it in peek():
        if it.get("kind") == kind:
            return it
    return None
