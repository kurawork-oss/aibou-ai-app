"""
端末から届いた記憶と、サーバー側の記憶を混ぜる所の検証。

なぜここが要るのか
------------------
記憶は2か所にある。

  サーバー側 … 意味で引ける（埋め込み × pgvector）が、Supabase が要る
  端末の中   … 通信なしで引けるが、意味では引けない

繋いでいない人にはサーバー側が空、古い画面や別端末からは端末側が空。
**どちらか片方しか無いのが普通**なので、片方が欠けても成り立つこと。
"""

from main import MAX_CLIENT_MEMORY, merge_memory

HEAD = "【関連する記憶】"


def test_両方あれば1つにまとまる():
    out = merge_memory(f"{HEAD}\n- (★事実) A", f"{HEAD}\n- (覚え) B")
    assert out.count(HEAD) == 1, "見出しが2つ並ぶと、AIは別々の資料として読む"
    assert "- (★事実) A" in out and "- (覚え) B" in out


def test_サーバー側が空でも端末の記憶が届く():
    # Supabase を繋いでいない人。ここが落ちると、その人の記憶はゼロに戻る
    out = merge_memory("", f"{HEAD}\n- (覚え) 甲殻類アレルギー")
    assert "甲殻類アレルギー" in out
    assert out.startswith(HEAD)


def test_端末側が空でも今までどおり():
    out = merge_memory(f"{HEAD}\n- (★事実) 既存", None)
    assert "既存" in out


def test_どちらも無ければ空を返す():
    # 空の見出しだけを渡すと、AIは「記憶が無い」ではなく
    # 「記憶を渡されたが空だった」と読む
    assert merge_memory("", "") == ""
    assert merge_memory("", None) == ""
    assert merge_memory(HEAD, HEAD) == ""


def test_同じ記憶が両方にあっても1行にする():
    same = "- (★事実) 妹の誕生日は3月12日"
    out = merge_memory(f"{HEAD}\n{same}", f"{HEAD}\n{same}")
    assert out.count(same) == 1


def test_端末から届く量に上限がある():
    """ここを開けておくと、画面側の不具合や細工で指示文をいくらでも
    膨らませられる。費用にも待ち時間にも直結する。"""
    huge = HEAD + "\n" + ("- とても長い記憶 " * 5000)
    out = merge_memory("", huge)
    assert len(out) <= MAX_CLIENT_MEMORY + len(HEAD) + 2


def test_行数にも上限がある():
    many = HEAD + "\n" + "\n".join(f"- 記憶{i}" for i in range(200))
    out = merge_memory("", many)
    assert len(out.splitlines()) <= 25


def test_サーバー側を先に置く():
    """サーバー側は意味で引いている（より的確なことが多い）ので先に出す。
    AIは前に置かれた物を重く見る傾向がある。"""
    out = merge_memory(f"{HEAD}\n- サーバーの記憶", f"{HEAD}\n- 端末の記憶")
    assert out.index("サーバーの記憶") < out.index("端末の記憶")


def test_壊れた入力でも落ちない():
    for bad in (None, "", "  ", "見出しのない行だけ"):
        merge_memory(bad, bad)          # 例外が出ないこと
