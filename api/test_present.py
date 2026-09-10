# test_present.py — 道具が作った物を、会話の隣に出せているか
#
# これまで道具は全部「文字列」しか返していなかった。だから
#
#   画像を作る → 「画像を生成しました：https://…（HOMEの『生成物』からも見られます）」
#   資料を作る → 「HOMEの『生成物』からダウンロードできます」
#   検索する   → 番号付きの文字列（リンクも押せない）
#
# と、作っておいて「別の場所へ見に行ってください」と案内していた。
# 頼んだ人が見たいのは、いま作った物であって住所ではない。
#
# ここで確かめるのは3つ。
#   ① 作った道具が、見せる物を置いていること
#   ② その置き場が、人ごとに分かれていること（混ざると他人の物が出る）
#   ③ 置けなくても道具は落ちないこと（見せ方の都合で作業を止めない）

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import present
import tools


@pytest.fixture
def box():
    token = present.begin()
    yield
    present.end(token)


# ── ① 作った物が置かれる ─────────────────────────────────────────
def test_a_generated_image_is_handed_over_not_just_described(box, monkeypatch):
    """「HOMEの生成物から見てください」ではなく、画像そのものを渡す。"""
    monkeypatch.setitem(sys.modules, "imagegen", _fake(generate=lambda *a, **k: {
        "ok": True, "url": "https://example.com/cat.png"}))
    out = tools.execute_tool("generate_image", {"prompt": "猫の絵"})

    got = present.take()
    assert len(got) == 1
    assert got[0]["kind"] == "image"
    assert got[0]["url"] == "https://example.com/cat.png"
    assert "猫の絵" in got[0]["title"]
    # 文章のほうから「別の場所へ行け」が消えていること
    assert "HOMEの" not in out


def test_search_results_are_handed_over_as_data_not_only_text(box, monkeypatch):
    """URLが文字列の中にしか無いと、スマホでは選んで貼り直すしかない。"""
    monkeypatch.setitem(sys.modules, "web", _fake(web_search=lambda q, n: {
        "ok": True, "results": [
            {"title": "みだし", "url": "https://example.com/a", "snippet": "ようやく"},
        ]}))
    out = tools.execute_tool("web_search", {"query": "テスト"})

    got = present.take()
    assert got and got[0]["kind"] == "search"
    assert got[0]["query"] == "テスト"
    assert got[0]["results"][0]["url"] == "https://example.com/a"
    # AIに渡る文章は今まで通り（あちらは読ませるためのもの）
    assert "https://example.com/a" in out


def test_a_document_hands_over_its_content(box, monkeypatch):
    monkeypatch.setitem(sys.modules, "artifacts", _fake(create=lambda *a, **k: {
        "id": "art-1", "title": "議事録"}))
    tools.execute_tool("create_document", {"title": "議事録", "content": "# 見出し\n本文"})

    got = present.take()
    assert got and got[0]["kind"] == "document"
    assert got[0]["artifact_id"] == "art-1"
    assert "# 見出し" in got[0]["content"]


def test_a_read_page_says_where_it_read(box, monkeypatch):
    """AIの要約だけだと、元を当たれない。"""
    monkeypatch.setitem(sys.modules, "web", _fake(web_read=lambda u, n: {
        "ok": True, "title": "記事", "text": "中身"}))
    tools.execute_tool("web_read", {"url": "https://example.com/x"})

    got = present.take()
    assert got and got[0]["kind"] == "page"
    assert got[0]["url"] == "https://example.com/x"


def test_work_that_needs_no_canvas_shows_nothing(box):
    """何でも出すと、肝心な物が埋もれる。

    タスクを1件足した、覚えた、は文章で足りる。
    """
    tools.execute_tool("remember", {"content": "誕生日は5月"})
    assert present.take() == []


# ── 図で説明する ─────────────────────────────────────────────────
def test_a_diagram_is_handed_over_to_be_drawn(box):
    """言葉で並べると長くなるもの（手順・関係・構成）を図にする。"""
    src = "flowchart TD\n  A[話しかける] --> B[道具を選ぶ]\n  B --> C[実行]"
    out = tools.execute_tool("draw_diagram", {"title": "流れ", "source": src})

    got = present.take()
    assert got and got[0]["kind"] == "diagram"
    assert got[0]["source"] == src
    assert got[0]["title"] == "流れ"
    assert "図" in out


def test_a_diagram_that_cannot_be_drawn_is_refused_early(box):
    """描けない物を渡されたら、描く前に言う。

    `#図解 開発の流れ` の「開発の流れ」は mermaid の記法ではない。
    そのまま渡すと画面側で必ず失敗し、利用者には
    「図が出なかった」としか見えない。
    """
    out = tools.execute_tool("draw_diagram", {"source": "開発の流れ"})
    assert present.take() == []
    assert "図の種類が分かりません" in out
    # 何で書けばいいかまで書いてある（ここが無いと直しようがない）
    assert "flowchart" in out


def test_the_shape_check_stays_shallow(box):
    """種類さえ合っていれば通す。

    mermaid の文法を丸ごと持つと、本家が更新されるたびにこちらが
    古びて、描ける図を弾くようになる。判定は浅いままにする。
    """
    for src in ["sequenceDiagram\n  A->>B: やあ",
                "mindmap\n  root((考え))",
                "gantt\n  title 予定",
                "  flowchart LR\n  A --> B"]:      # 前に空白があっても
        tools.execute_tool("draw_diagram", {"source": src})
        assert present.take(), f"描けるはずの図を弾いた: {src[:20]}"


def test_a_diagram_command_goes_to_the_ai_rather_than_guessing():
    """`#図解 開発の流れ` は、AIに記法へ直してもらってから描く。

    自由文をそのまま source に入れる近道を作ると、#図解 が必ず
    失敗する入口になる。
    """
    import main
    cap = next(c for c in __import__("capabilities").CAPABILITIES
               if c["cmd"] == "図解")
    assert main._command_params(cap, "開発の流れ") is None


# ── ② 人ごとに分かれている ───────────────────────────────────────
def test_two_people_do_not_see_each_others_work():
    """ここが混ざると、Aさんが作った画像がBさんの画面に出る。

    保存先の切り替えと同じ考え方（ContextVar）でリクエストごとに分ける。
    """
    seen = {}

    def one(name, url):
        token = present.begin()
        try:
            present.show({"kind": "image", "url": url, "title": name})
            # 相手が置くだけの間を作る
            barrier.wait(timeout=5)
            seen[name] = present.take()
        finally:
            present.end(token)

    barrier = threading.Barrier(2)
    a = threading.Thread(target=one, args=("A", "https://a/1.png"))
    b = threading.Thread(target=one, args=("B", "https://b/1.png"))
    a.start(); b.start(); a.join(); b.join()

    assert len(seen["A"]) == 1 and seen["A"][0]["url"] == "https://a/1.png"
    assert len(seen["B"]) == 1 and seen["B"][0]["url"] == "https://b/1.png"


def test_taking_empties_the_box(box):
    """1手ごとに回収する。空にしないと、次の手でも同じ物が流れる。"""
    present.show({"kind": "image", "url": "https://x/1.png"})
    assert len(present.take()) == 1
    assert present.take() == []


def test_the_box_is_closed_after_the_request():
    token = present.begin()
    present.show({"kind": "image", "url": "https://x/1.png"})
    present.end(token)
    # 閉じたあとに置いても、次の人には渡らない
    present.show({"kind": "image", "url": "https://y/1.png"})
    assert present.peek() == []


# ── ③ 見せ方の都合で作業を止めない ───────────────────────────────
def test_a_tool_still_works_when_nothing_is_listening(monkeypatch):
    """置き場が開いていなくても、道具は成功する。

    単体テストや別の経路から呼ばれることがある。ここで例外にすると、
    見せ方の都合で作業そのものが落ちる。
    """
    monkeypatch.setitem(sys.modules, "imagegen", _fake(generate=lambda *a, **k: {
        "ok": True, "url": "https://example.com/cat.png"}))
    out = tools.execute_tool("generate_image", {"prompt": "猫"})
    assert "https://example.com/cat.png" in out


def test_unknown_kinds_are_dropped(box):
    """画面が知らない種類を渡しても、空の枠が出るだけなので捨てる。"""
    present.show({"kind": "とつぜんの新種", "url": "x"})
    present.show("文字列")            # そもそも形が違う
    present.show({"url": "kindが無い"})
    assert present.take() == []


def test_a_failed_tool_shows_nothing(box, monkeypatch):
    """作れていないのに、作った物として出さない。"""
    monkeypatch.setitem(sys.modules, "imagegen", _fake(generate=lambda *a, **k: {
        "ok": False, "error": "鍵がありません"}))
    out = tools.execute_tool("generate_image", {"prompt": "猫"})
    assert present.take() == []
    assert "できませんでした" in out


# ── 小道具 ───────────────────────────────────────────────────────
def _fake(**attrs):
    mod = type("FakeModule", (), attrs)
    return mod
