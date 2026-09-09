# test_toolcall.py — 道具の呼び出しを、正式な口で行うこと
#
# これまでの作り:
#   モデルに「返答の1行目に <<<TOOL_CALL>>>{...} と書け」と文章で頼み、
#   返ってきた文章からその文字列を探していた。目印の書き忘れ・前置き付き・
#   引数のJSON破損が普通に起きる。
#
# いまの作り:
#   Gemini / OpenAI が正式に備えている function calling を使う。
#   使えないモデル（HuggingFace経由など）では、これまでの方式に落ちる。
#   「正式な口が無いと道具が使えない」にはしない。

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent
import config
import toolcall
import toolschema
import tools


# ── モデルの応答を模す ───────────────────────────────────────────────
class _FakeFC:
    def __init__(self, name, args):
        self.name = name
        self.args = args


class _FakePart:
    def __init__(self, text="", fc=None):
        self.text = text
        self.function_call = fc


class _FakeResp:
    def __init__(self, parts):
        content = type("C", (), {"parts": parts})()
        self.candidates = [type("Cand", (), {"content": content})()]


# ── 正式な口（Gemini） ──────────────────────────────────────────────
def test_gemini_function_calling_is_used(monkeypatch):
    """文章を探さず、構造化された呼び出しをそのまま受け取ること。"""
    seen = {}

    def fake(prompt, tools=None, **kw):
        seen["tools"] = tools
        return _FakeResp([_FakePart(fc=_FakeFC("add_task", {"title": "牛乳を買う"}))])

    monkeypatch.setattr(config, "generate_resilient", fake)
    got = toolcall.decide("指示", "指示（目印版）", {"add_task"}, tools.TOOL_DOCS)

    assert got["native"] is True
    assert got["call"] == {"tool": "add_task", "params": {"title": "牛乳を買う"}}
    # 道具は「宣言」として渡している（文章での説明ではない）
    decls = seen["tools"][0]["function_declarations"]
    assert decls[0]["name"] == "add_task"
    assert "title" in decls[0]["parameters"]["properties"]
    assert decls[0]["parameters"]["required"] == ["title"]


def test_the_native_prompt_does_not_ask_for_the_marker(monkeypatch):
    """正式な口を使うときに、目印を書けという指示を混ぜないこと。

    混ぜるとモデルが目印を書いてしまい、正式な呼び出しが来なくなる。
    """
    seen = {}

    def fake(prompt, tools=None, **kw):
        seen["prompt"] = prompt
        return _FakeResp([_FakePart(text="はい")])

    monkeypatch.setattr(config, "generate_resilient", fake)
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    list(agent.run_stream("こんにちは"))

    assert toolcall.MARKER not in seen["prompt"], "目印の指示が混ざっている"
    assert "【利用可能なツール】" not in seen["prompt"], "道具の一覧が二重に乗っている"


def test_text_only_answer_needs_no_tool(monkeypatch):
    monkeypatch.setattr(config, "generate_resilient",
                        lambda p, tools=None, **k: _FakeResp([_FakePart(text="こんにちは")]))
    got = toolcall.decide("やあ", "やあ", {"add_task"}, tools.TOOL_DOCS)
    assert got["call"] is None and got["text"] == "こんにちは"


def test_gemini_odd_argument_types_are_flattened(monkeypatch):
    """Geminiは素のdictではない入れ物で引数を返す。素の形に直せること。"""
    class Weird:
        def __init__(self, d): self._d = d
        def __iter__(self): return iter(self._d)
        def __getitem__(self, k): return self._d[k]

    monkeypatch.setattr(config, "generate_resilient",
                        lambda p, tools=None, **k: _FakeResp([
                            _FakePart(fc=_FakeFC("google_sheet",
                                                 Weird({"title": "表", "rows": [["a"]]})))]))
    got = toolcall.decide("表を作って", "表を作って", {"google_sheet"}, tools.TOOL_DOCS)
    assert got["call"]["params"]["title"] == "表"
    assert got["call"]["params"]["rows"] == [["a"]]


# ── 落ちる先（これまでの方式） ───────────────────────────────────────
def test_it_falls_back_to_the_marker_when_native_is_unavailable(monkeypatch):
    """正式な口が使えないモデルでも、道具が使えなくならないこと。"""
    monkeypatch.setattr(config, "generate_resilient", lambda *a, **k: None)
    import llm
    monkeypatch.setattr(llm, "_openai_token", lambda: "")
    monkeypatch.setattr(
        llm, "generate_text",
        lambda p, **k: toolcall.MARKER + '{"tool":"add_task","params":{"title":"牛乳"}}')

    got = toolcall.decide("買い物", "買い物（目印版）", {"add_task"}, tools.TOOL_DOCS)
    assert got["native"] is False
    assert got["call"] == {"tool": "add_task", "params": {"title": "牛乳"}}


def test_the_fallback_prompt_does_carry_the_marker_instructions(monkeypatch):
    """落ちる先では、道具の一覧と目印の頼み方をちゃんと渡すこと。"""
    seen = {}
    monkeypatch.setattr(config, "generate_resilient", lambda *a, **k: None)
    import llm
    monkeypatch.setattr(llm, "_openai_token", lambda: "")
    monkeypatch.setattr(llm, "generate_text",
                        lambda p, **k: (seen.update(prompt=p), "終わりました")[1])
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")
    list(agent.run_stream("なにかして"))

    assert toolcall.MARKER in seen["prompt"]
    assert "【利用可能なツール】" in seen["prompt"]


# ── 引数の検査は、実行の前に必ず通ること ─────────────────────────────
def test_bad_arguments_from_the_model_are_explained_not_crashed(monkeypatch):
    """モデルが形を間違えても、例外ではなく直し方が返ること。

    以前は引数を素通ししていたので、道具の中で例外になり
    「ツール実行エラー（...）」という読めない文が利用者に届いていた。
    """
    monkeypatch.setattr(config, "generate_resilient",
                        lambda p, tools=None, **k: _FakeResp([
                            _FakePart(fc=_FakeFC("add_task", {"priority": "とても高い"}))]))
    monkeypatch.setattr(agent, "_rules_always", lambda: "")
    monkeypatch.setattr(agent, "_rules_topic", lambda t: "")

    events = list(agent.run_stream("タスク入れて"))
    obs = [e for e in events if e.get("phase") == "observation"]
    assert obs, "道具を実行した記録が無い"
    result = obs[0]["result"]
    assert "title" in result and "足りません" in result
    assert "ツール実行エラー" not in result


def test_declarations_follow_the_enabled_tools():
    """AIに宣言する道具と、説明を渡す道具が食い違わないこと。"""
    names = agent._tool_names()
    decls = toolschema.declarations(names, tools.TOOL_DOCS)
    assert {d["name"] for d in decls} == set(names)


def test_every_tool_can_be_declared():
    """宣言を作れない道具が無いこと（作れないと、その道具は永久に呼ばれない）。"""
    for name in tools._DISPATCH:
        d = toolschema.declaration(name, "説明")
        assert d is not None, f"{name} の宣言が作れない"
        assert d["parameters"]["type"] == "object"


# ── 会話が止まらないこと ─────────────────────────────────────────────
def test_a_provider_failure_does_not_stop_the_conversation(monkeypatch):
    """正式な口が例外を投げても、落ちる先へ進むこと。"""
    def boom(*a, **k):
        raise RuntimeError("提供元が落ちている")
    monkeypatch.setattr(config, "generate_resilient", boom)
    import llm
    monkeypatch.setattr(llm, "_openai_token", lambda: "")
    monkeypatch.setattr(llm, "generate_text", lambda p, **k: "こんにちは")

    got = toolcall.decide("やあ", "やあ", {"add_task"}, tools.TOOL_DOCS)
    assert got["native"] is False and got["text"] == "こんにちは"
