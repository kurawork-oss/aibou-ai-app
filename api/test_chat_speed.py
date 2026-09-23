"""
話しかけてから喋り出すまでの速さ。

なぜここを見張るのか
--------------------
記憶の想起は**返事の1文字目より前**に終わらせる必要がある。つまりここでの
待ち時間は、そのまま体感の遅さになる。しかも遅くなっても画面は壊れないので、
「なんとなくもっさりする」としか感じられず、誰も不具合として報告しない。

実測（Render→Gemini/Supabase の往復を模した値）:

  意味検索が効くDB   毎メッセージ 2往復 / 410ms（埋め込み320 + RPC90）
  効かないDB         1通目だけ1往復、以降は20秒キャッシュで 0往復

意味検索の土台（pgvector）はこれまでどのDBにも作られていなかったので、
実際には後者だった。それを直した結果、このままでは**全員が毎回410ms待つ**。
"""

import asyncio
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main


def slow_recall(ms):
    def _recall(_msg, limit=8):
        time.sleep(ms / 1000)
        return "【関連する記憶】\n- (★事実) 朝は7時に起きる"
    return _recall


@pytest.fixture
def fast_budget(monkeypatch):
    """テストが実時間で待たなくて済むよう、制限時間を縮める。"""
    monkeypatch.setattr(main, "RECALL_BUDGET_WITH_LOCAL", 0.12)
    monkeypatch.setattr(main, "RECALL_BUDGET_ALONE", 0.40)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_想起が間に合えば_ちゃんと使う(monkeypatch, fast_budget):
    monkeypatch.setattr(main, "mem_recall", slow_recall(10))
    out = run(main.recall_within_budget("明日の予定は？", "【関連する記憶】\n- (覚え) 端末の分"))
    assert "朝は7時に起きる" in out, "間に合っているのに捨てている"


def test_遅い想起で_返事を待たせない(monkeypatch, fast_budget):
    """ここが無いと、記憶のために毎回400ms喋り出しが遅れる。"""
    monkeypatch.setattr(main, "mem_recall", slow_recall(1500))
    t0 = time.time()
    out = run(main.recall_within_budget("明日の予定は？", "【関連する記憶】\n- (覚え) 端末の分"))
    ms = (time.time() - t0) * 1000
    assert out == "", "時間切れなのに待ち続けている"
    assert ms < 400, f"制限時間を超えて待っている（{ms:.0f}ms）"


def test_端末に記憶が無いときは_長めに待つ(monkeypatch, fast_budget):
    """新しい端末では、サーバー側が唯一の記憶。ここで諦めると本当に何も無い。"""
    monkeypatch.setattr(main, "mem_recall", slow_recall(250))
    out = run(main.recall_within_budget("明日の予定は？", ""))
    assert "朝は7時に起きる" in out, "端末が空なのに、待たずに諦めている"

    # 同じ250msでも、端末に記憶があるときは待たない
    out2 = run(main.recall_within_budget("明日の予定は？", "【関連する記憶】\n- (覚え) 端末の分"))
    assert out2 == "", "端末の分があるのに、長く待っている"


def test_想起が落ちても_会話は続く(monkeypatch, fast_budget):
    def boom(_m, limit=8):
        raise RuntimeError("Supabase down")
    monkeypatch.setattr(main, "mem_recall", boom)
    assert run(main.recall_within_budget("やあ", "")) == ""


def test_時間切れでも_裏で走り切る(monkeypatch, fast_budget):
    """止めてしまうと、次の発言も同じだけ待つことになる。
    走り切らせればキャッシュが温まり、2通目から速くなる。"""
    done = {"n": 0}

    def _recall(_m, limit=8):
        time.sleep(0.3)
        done["n"] += 1
        return "【関連する記憶】\n- (★事実) 朝は7時に起きる"

    monkeypatch.setattr(main, "mem_recall", _recall)
    assert run(main.recall_within_budget("質問", "端末の分")) == ""
    time.sleep(0.5)
    assert done["n"] == 1, "時間切れで打ち切ってしまっている（次も同じだけ待つ）"


def test_制限時間は環境変数で変えられる():
    """遅いDBの人が、自分で伸ばせるようにしておく。"""
    assert main.RECALL_BUDGET_WITH_LOCAL > 0
    assert main.RECALL_BUDGET_ALONE > main.RECALL_BUDGET_WITH_LOCAL, \
        "端末が空のときのほうが短いと、新しい端末で記憶が使えない"


# ── 道具の説明書を、毎回は積まない ──────────────────────────────────
#
# 会話の system prompt の79%が説明書だった（4,360字中3,464字・27個）。
# 「ありがとう」にも毎回積んでいて、しかも同じプロンプトの中で
# 「通常の会話・質問では絶対に使わないこと」と書いている。

import toolgate


ACTION = [
    "明日15時に歯医者の予定を入れて",
    "牛乳を買うのをタスクに追加",
    "このメール読んで要約して",
    "今日の天気は？",
    "最新のニュース教えて",
    "Notionから議事録探して",
    "GitHubのissue作って",
    "来週の予定を見せて",
    "スライド作って",
    "あとでリマインドして",
    "為替どうなってる",
    "転職しようか迷っていて、いまの職場の条件を整理して比べたい",  # 長い依頼
    # 手元のパソコンとブラウザ。以前はここが1つも拾えず、会話では道具を
    # 積まずに答えていた
    "日誌に書いておいて",
    "手元のフォルダのPDFを読んで",
    "社内ポータルでケースを開いて",
    "ブラウザで開いて",
    "朝のケース確認を流して",
]

CHAT = [
    "ありがとう", "なるほど", "うん", "そうなんだ", "おはよう", "すごいね",
    "わかった", "疲れた", "Pythonのリスト内包表記って何？", "それどういう意味？",
    "日本の首都は？", "どう思う？",
]


@pytest.mark.parametrize("text", ACTION)
def test_行動を頼まれたら_必ず道具を積む(text):
    """外し過ぎる失敗は「できるはずのことをやってくれない」になる。
    そちらのほうが、少し遅いより悪い。"""
    ok, why = toolgate.needs_tools(text)
    assert ok, f"「{text}」で道具を外している（理由: {why}）"


@pytest.mark.parametrize("text", CHAT)
def test_ふつうの会話では_道具を積まない(text):
    ok, why = toolgate.needs_tools(text)
    assert not ok, f"「{text}」に説明書3,464字を積んでいる（理由: {why}）"


def test_外したときは_代わりの案内を添える():
    """何も言わないと、モデルは「私にはできません」と答えてしまう。
    **できないのではなく、いま渡していないだけ**だと分かるようにする。"""
    assert "実行" in toolgate.NO_TOOLS_NOTE
    assert len(toolgate.NO_TOOLS_NOTE) < 200, "代わりの案内が長すぎては意味が無い"


def test_判断の理由が必ず残る():
    for text in ["ありがとう", "タスク追加して", ""]:
        _ok, why = toolgate.needs_tools(text)
        assert why, f"「{text}」でなぜそう判断したのか分からない"


def test_積むときと積まないときで_長さが大きく違う():
    """ここが縮んでいなければ、判断を足した意味が無い。"""
    import agent
    import main as m
    base = len(m.build_system_prompt("AIbou", "", ""))
    doc = len(agent._tools_doc())
    lite = base + len(toolgate.NO_TOOLS_NOTE)
    full = base + doc
    assert lite < full * 0.4, f"減っていない（{lite} / {full}）"
