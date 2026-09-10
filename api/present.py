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
    _items.reset(token)


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
