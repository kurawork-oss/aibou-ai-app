"""
毎回のやり取りに何を積んでいるか。

なぜ見張るのか
--------------
system prompt は**毎メッセージ丸ごと送る**。入力が長いほど、最初の1文字が
出るまでの時間も費用も増える。しかも画面は壊れないので「なんとなく
もっさりする」としか感じられず、誰も不具合として報告しない。

実測（道具の説明書を毎回積むのをやめたあと）:

    雑談のとき    933字   ← うち 616字が「このアプリについて」
    依頼のとき  4,473字   ← うち 3,620字が道具の説明書

残っている 616字には、もう1つ問題がある。**中身が古い**。

    「画面（モード）: HOME / CHAT / ME / TASKS / BOARD / VAULT / CODE /
      STUDIO / CAPTURE / SNS / INCOME / AUTO / ARCHIVE」

画面は「実行」と「管理」の2つに畳んであり、さらに使う機能のかたまりを
切っている人には、この一覧の半分が出ていない。それでもAIは毎回この一覧を
渡されるので、**その人の画面に無いモードを案内する**。

いま何ができるかは `self_check` が実データで答えられる。静的な文章に
持たせる必要はもう無い——持たせると、増えるたびに古くなる。
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent
import guide
import main
import toolgate


def base() -> str:
    return main.build_system_prompt("AIbou", "", "")


# ── 大きさ ──────────────────────────────────────────────────────────

def test_雑談のときの土台が_短い():
    """ここは「ありがとう」にも毎回付く。"""
    n = len(base())
    assert n < 450, f"毎回積む土台が大きい（{n}字）"


def test_依頼のときも_道具の説明が主役():
    """土台が膨らむと、道具の説明を絞った意味が薄れる。"""
    b = len(base())
    doc = len(agent._tools_doc())
    assert b < doc * 0.2, f"土台が大きすぎる（土台 {b} / 説明 {doc}）"


# ── 古くなる物を積まない ────────────────────────────────────────────

def test_画面の名前を_毎回は積まない():
    """画面の顔ぶれは、使う機能のかたまりと設定で人ごとに変わる。
    固定の一覧を渡すと、その人に無いモードを案内する。"""
    b = base()
    # 旧い一覧に並んでいた名前。どれか1つでも残っていたら積んでいる。
    for name in ["ARCHIVE", "CAPTURE", "STUDIO", "INCOME", "VAULT"]:
        assert name not in b, f"画面の名前（{name}）を毎回積んでいる"


def test_できることは_調べてから答えると書いてある():
    """静的な説明を外すなら、代わりに**調べる道**を示しておかないと、
    モデルは推測で答える（いちばん困る形）。"""
    b = base()
    assert "self_check" in b, "調べ方が書いていない"


def test_無い機能をでっち上げない指示は_残っている():
    assert "実装に無い" in base() or "あるかのように" in base()


# ── 「何ができる？」で、調べる道具が渡る ──────────────────────────

CAPABILITY_QUESTIONS = [
    "何ができるの？",
    "なにができる",
    "使い方を教えて",
    "Notionは使える？",
    "Googleカレンダーつながってる？",
    "いま何が設定できてない？",
    "この機能ある？",
]


@pytest.mark.parametrize("text", CAPABILITY_QUESTIONS)
def test_できることを聞かれたら_道具を積む(text):
    """積まないと self_check を呼べず、推測で答えることになる。
    静的な説明を外したぶん、ここは外せない。"""
    ok, why = toolgate.needs_tools(text)
    assert ok, f"「{text}」で道具を外している（理由: {why}）"


def test_ふつうの雑談は_今まで通り積まない():
    for text in ["ありがとう", "なるほど", "おはよう", "疲れた"]:
        ok, _why = toolgate.needs_tools(text)
        assert not ok, f"「{text}」に説明書を積んでいる"


# ── 画面のガイドは、今まで通り出せる ──────────────────────────────

def test_画面のガイドそのものは_消していない():
    """毎回の会話に積まないだけで、説明書の画面は今まで通り。"""
    modes = guide.modes(owner=True)
    assert modes, "説明書が空になっている"
    names = " ".join(str(m) for m in modes)
    assert "会話" in names, "会話（実行）の説明が無い"
