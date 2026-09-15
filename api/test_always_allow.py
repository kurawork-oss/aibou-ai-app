"""
「この操作はいつも許可」を見張る。

なぜ足したのか
--------------
同じ確認が何度も出ると、**読まずに押す癖**がつく。そうなると、本当に
読んでほしい確認（メールを送る・お金が動く）も一緒に素通りする。
確認の数を減らすことが、残った確認をちゃんと読ませることになる。

ここで守りたいのは、その逆側
----------------------------
「いつも許可」が効いてはいけない所で効いてしまうと、いちばん困る形の
事故になる——**押した覚えのないメールが飛ぶ**。効かせない所を、
画面ではなくサーバー側で縛る。画面の作りは変わるが、ここは変わらない。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import risk


# ── 効いてよい所 ────────────────────────────────────────────────────

def test_level2_can_be_allowed_once_and_for_all():
    """外に残る操作（カレンダー追加など）は、許せば聞かなくなる。"""
    assert risk.needs_confirmation("calendar_add", True) is True
    assert risk.needs_confirmation("calendar_add", True, allowed={"calendar_add"}) is False


def test_allowing_one_tool_does_not_allow_its_neighbours():
    assert risk.needs_confirmation("notion_add", True, allowed={"calendar_add"}) is True


def test_may_always_is_true_for_level2():
    assert risk.may_always_allow("calendar_add") is True
    assert risk.describe("calendar_add")["may_always"] is True


# ── 効いてはいけない所 ──────────────────────────────────────────────

def test_irreversible_tools_are_always_confirmed_even_if_allowed():
    """毎回聞くことが、段階3の中身そのもの。ここが抜けたら分けた意味が無い。"""
    for tool in ("send_email", "notify", "enqueue_income", "run_automation"):
        assert risk.needs_confirmation(tool, False, allowed={tool}) is True, tool
        assert risk.may_always_allow(tool) is False, tool
        assert risk.describe(tool)["may_always"] is False, tool


def test_chained_reads_are_always_confirmed_even_if_allowed():
    """聞いている理由が「危なさ」ではなく「誰が決めたか」。

    外のページを1枚読んだ後は、次のURLがそのページに書かれていた物かも
    しれない（`https://悪い所/?data=<会話の中身>` で持ち出せる）。
    道具ごとに一度許してよい性質の物ではない。
    """
    assert risk.needs_confirmation("web_read", False, external_reads=1,
                                   allowed={"web_read"}) is True
    assert risk.may_always_allow("web_read", external_reads=1) is False
    # 1枚も読んでいなければ、ふつうに許してよい（そもそも聞いていない）
    assert risk.may_always_allow("web_read", external_reads=0) is True


def test_unknown_tools_cannot_be_allowed():
    """段階を書き忘れた道具は段階3扱い。許可の一覧に入れても聞く。"""
    assert risk.needs_confirmation("brand_new_tool", False,
                                   allowed={"brand_new_tool"}) is True
    assert risk.may_always_allow("brand_new_tool") is False


def test_allowed_does_not_turn_on_confirmation_for_safe_tools():
    """読むだけの物は、もともと聞いていない。許可で何も変わらない。"""
    assert risk.needs_confirmation("web_search", True) is False
    assert risk.needs_confirmation("web_search", True, allowed={"web_search"}) is False


def test_allowed_accepts_any_iterable():
    assert risk.needs_confirmation("calendar_add", True, allowed=["calendar_add"]) is False
    assert risk.needs_confirmation("calendar_add", True, allowed=()) is True
    assert risk.needs_confirmation("calendar_add", True, allowed=None) is True


# ── 口（/agent/act） ────────────────────────────────────────────────

def test_the_request_carries_the_allow_list():
    import main
    assert "allow" in main.AgentActRequest.model_fields


def test_every_tool_says_whether_it_can_be_allowed():
    """画面が「いつも許可」を出すかどうかは、ここだけを見て決める。"""
    for row in risk.table():
        assert isinstance(row["may_always"], bool), row["tool"]
        # 取り返せない物に出していないこと
        if row["level"] >= 3:
            assert row["may_always"] is False, row["tool"]
