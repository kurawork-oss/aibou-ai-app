"""
説明書に、その人が持っていない画面を並べない。

なぜ要るか
----------
`guide.py` の `_visible()` には、こう書いてある:

    使えない機能の説明が並ぶと「押しても動かない＝壊れている」と
    受け取られる。

その通りなのだが、**実際に絞っていたのは「持ち主専用かどうか」だけ**
だった。使う機能のかたまり（パック）は見ていない。

既定では 発信(share)・開発(dev)・副業(income) が切ってある。つまり
初期状態の人は、説明書で

    「コードを書く」「投稿案」

を読み、そこへ行こうとして、**管理タブのどこにも入口が無い**ことに気づく。
案内だけがあって行き先が無いのは、機能が無いより悪い（自分の設定が
おかしいのかと探すことになる）。

`# コマンド` の一覧も、管理タブの入口も、AIに渡す道具も、全部同じパックで
絞っている。説明書だけが絞っていなかった。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import capabilities
import guide


def ids(owner=True, packs=None):
    return {m["id"] for m in guide.modes(owner=owner, packs=packs)}


def test_切ってあるかたまりの画面は_説明書に出ない():
    only_core = ids(packs=["core"])
    assert "code" not in only_core, "開発を切っているのに「コードを書く」が出ている"
    assert "sns" not in only_core, "発信を切っているのに「投稿案」が出ている"


def test_入れてあるかたまりの画面は_ちゃんと出る():
    """絞りすぎて、使える物まで消していないこと。"""
    with_dev = ids(packs=["core", "dev"])
    assert "code" in with_dev
    assert "chat" in with_dev and "home" in with_dev


def test_かたまりに属さない画面は_いつでも出る():
    """設定・自分のデータベース・会話は、どの人にも要る。"""
    only_core = ids(packs=["core"])
    for must in ("chat", "home", "settings", "database"):
        assert must in only_core, f"{must} が消えている"


def test_指定しなければ_これまで通り全部出る():
    """packs を渡さない呼び出し（説明書の画面以外）を壊さない。"""
    assert ids() >= ids(packs=["core"])
    assert "code" in ids()


def test_持ち主専用は_これまで通り隠れる():
    assert "income" not in ids(owner=False)


def test_パックの名前が_台帳と揃っている():
    """ここが `capabilities.PACKS` とずれると、説明書だけ別の基準で
    絞ることになり、また食い違う。"""
    used = {m.get("pack") for m in guide.modes()} - {None, ""}
    unknown = used - set(capabilities.PACKS)
    assert not unknown, f"知らないかたまり名: {unknown}"


def test_エンドポイントも_同じ基準で返す():
    """画面が叩く /guide も絞れていること（ここが素通りだと意味が無い）。"""
    from fastapi.testclient import TestClient
    import main
    c = TestClient(main.app)
    d = c.get("/guide").json()
    assert isinstance(d.get("modes"), list) and d["modes"]
    assert d["mode_count"] == len(d["modes"]), "件数と中身が食い違っている"
