"""
会話から事実を取り出す所（facts.py）を見張る。

ここで守りたいのは「取れること」より、**言っていないことを残さないこと**。
入ってしまった嘘は、以後ずっと毎回AIへ送られる。本人が記憶の画面を
見に行くまで誰も気づかない。
"""

import datetime as dt

import pytest

import facts


# ── 畳み方 ──────────────────────────────────────────────────────────

def test_turns_are_labelled_by_who_spoke():
    text = facts._as_text([
        {"role": "user", "content": "沖縄に行く"},
        {"role": "assistant", "content": "いいですね"},
    ])
    assert "本人: 沖縄に行く" in text
    assert "AI: いいですね" in text


def test_long_history_keeps_the_newest_end():
    """切るなら古いほうを切る。新しい発言に新しい事実が入っている。"""
    turns = [{"role": "user", "content": "あ" * 500} for _ in range(20)]
    turns.append({"role": "user", "content": "最後のひとこと"})
    text = facts._as_text(turns)
    assert "最後のひとこと" in text
    assert len(text) <= facts.MAX_CONTEXT + 200


def test_empty_turns_are_dropped():
    assert facts._as_text([{"role": "user", "content": "  "}]) == ""


# ── プロンプト ──────────────────────────────────────────────────────

def test_prompt_carries_todays_date():
    """「来月」を絶対の日付に直させるには、今日が要る。"""
    p = facts.build_prompt([{"role": "user", "content": "来月引っ越す"}],
                           today="2026年09月15日")
    assert "2026年09月15日" in p


def test_prompt_lists_what_we_already_know():
    p = facts.build_prompt([{"role": "user", "content": "x"}],
                           known=["甲殻類アレルギーがある"])
    assert "甲殻類アレルギーがある" in p


def test_prompt_says_no_when_nothing_known():
    p = facts.build_prompt([{"role": "user", "content": "x"}], known=[])
    assert "まだありません" in p


def test_prompt_forbids_secrets():
    p = facts.build_prompt([{"role": "user", "content": "x"}])
    assert "鍵" in p and "パスワード" in p


# ── 受け取った物を絞る所（ここがAIを信じない側の砦） ────────────────

def test_secrets_never_enter_memory():
    """記憶は毎回AIへ送られる。一度入れば以後ずっと送られ続ける。"""
    body = "abcdefghijklmnopqrstuvwxyz0123456789" * 2
    key = "AIza" + body[:35]
    got = facts.clean([{"text": f"鍵は {key}"}, {"text": "犬を飼っている"}])
    assert [g["text"] for g in got] == ["犬を飼っている"]


def test_guesses_are_dropped():
    """「〜かもしれない」は推測。事実として残すと、あとで嘘になる。"""
    got = facts.clean([
        {"text": "引っ越すかもしれない"},
        {"text": "転職を考えているようだ"},
        {"text": "おそらく京都に住んでいる"},
        {"text": "京都に住んでいる"},
    ])
    assert [g["text"] for g in got] == ["京都に住んでいる"]


def test_facts_about_the_ai_are_dropped():
    got = facts.clean([{"text": "AIは親切に答えた"}, {"text": "私は元気です"},
                       {"text": "月曜は在宅で働いている"}])
    assert [g["text"] for g in got] == ["月曜は在宅で働いている"]


def test_already_known_is_not_added_again():
    got = facts.clean([{"text": "甲殻類アレルギーがある"}],
                      known=["甲殻類アレルギーがある。"])
    assert got == []


def test_same_fact_twice_in_one_answer_is_kept_once():
    got = facts.clean([{"text": "犬を飼っている"}, {"text": "犬を飼っている"}])
    assert len(got) == 1


def test_too_short_and_too_long_are_dropped():
    got = facts.clean([{"text": "犬"}, {"text": "あ" * 400},
                       {"text": "犬を飼っている"}])
    assert [g["text"] for g in got] == ["犬を飼っている"]


def test_importance_is_clamped():
    got = facts.clean([{"text": "甲殻類アレルギーがある", "importance": 9},
                       {"text": "コーヒーが好き", "importance": "x"}])
    assert got[0]["importance"] == 1
    assert got[1]["importance"] == 0


def test_never_takes_more_than_the_cap():
    got = facts.clean([{"text": f"事実その{i}です"} for i in range(30)])
    assert len(got) == facts.MAX_PER_CALL


def test_plain_strings_are_accepted():
    """AIは配列の中身を文字列だけで返すことがある。捨てずに読む。"""
    assert facts.clean(["犬を飼っている"])[0]["text"] == "犬を飼っている"


def test_garbage_shapes_do_not_crash():
    assert facts.clean(None) == []
    assert facts.clean("なにか") == []
    assert facts.clean([1, None, {"nope": 1}]) == []


# ── 全体 ────────────────────────────────────────────────────────────

def test_extract_returns_empty_when_conversation_is_tiny(monkeypatch):
    """短すぎる会話でAIを呼ばない（呼ぶだけ無駄で、費用だけかかる）。"""
    called = []
    monkeypatch.setattr(facts, "jsonout", facts.jsonout)

    import llm
    monkeypatch.setattr(llm, "generate_text",
                        lambda *a, **k: called.append(1) or "[]")
    assert facts.extract([{"role": "user", "content": "うん"}]) == []
    assert called == []


def test_extract_reads_a_json_array(monkeypatch):
    import llm
    monkeypatch.setattr(
        llm, "generate_text",
        lambda *a, **k: '```json\n[{"text":"犬を飼っている","importance":0}]\n```')
    got = facts.extract([{"role": "user", "content": "うちの犬がさ、最近よく吠える"}])
    assert got == [{"text": "犬を飼っている", "importance": 0}]


def test_extract_uses_the_facts_task(monkeypatch):
    """`ROUTE_FACTS=ollama` で「記憶を作る所だけ手元で」ができること。"""
    seen = {}

    import llm

    def fake(prompt, **kw):
        seen.update(kw)
        return "[]"

    monkeypatch.setattr(llm, "generate_text", fake)
    facts.extract([{"role": "user", "content": "うちの犬がさ、最近よく吠える"}])
    assert seen.get("task") == "facts"


def test_extract_never_raises(monkeypatch):
    """返事のあとの裏方。ここが落ちても会話には何も起きてはいけない。"""
    import llm
    monkeypatch.setattr(llm, "generate_text",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    assert facts.extract([{"role": "user", "content": "うちの犬がさ、最近よく吠える"}]) == []


def test_extract_survives_unreadable_output(monkeypatch):
    import llm
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: "すみません、できません")
    assert facts.extract([{"role": "user", "content": "うちの犬がさ、最近よく吠える"}]) == []


def test_today_is_formatted_in_japanese():
    assert facts.today_str(dt.date(2026, 9, 15)) == "2026年09月15日"


@pytest.mark.parametrize("task", ["facts"])
def test_facts_task_exists_in_the_router(task):
    import router
    assert task in router.TASKS
    # 無料の物だけ。ここが有料だと、記憶を作るたびに黙って課金される。
    assert all(not router.PROVIDERS[p]["paid"] for p in router.TASKS[task])


# ── 口（/memory/extract） ───────────────────────────────────────────

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

from fastapi.testclient import TestClient      # noqa: E402
import main                                     # noqa: E402

client = TestClient(main.app)


def test_endpoint_returns_what_was_found(monkeypatch):
    monkeypatch.setattr(main.llm, "active_provider", lambda: "gemini")
    monkeypatch.setattr(main.facts, "extract",
                        lambda turns, known: [{"text": "犬を飼っている", "importance": 0}])
    r = client.post("/memory/extract",
                    json={"turns": [{"role": "user", "content": "うちの犬がさ"}]})
    assert r.status_code == 200
    assert r.json()["facts"][0]["text"] == "犬を飼っている"


def test_endpoint_is_quiet_when_there_is_no_ai(monkeypatch):
    """返事のあとの裏方なので、ここで騒いでも利用者には何のことか分からない。"""
    monkeypatch.setattr(main.llm, "active_provider", lambda: "none")
    r = client.post("/memory/extract",
                    json={"turns": [{"role": "user", "content": "うちの犬がさ"}]})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "facts": [], "why": "AI未設定"}


def test_endpoint_does_not_call_the_ai_for_an_empty_conversation(monkeypatch):
    called = []
    monkeypatch.setattr(main.facts, "extract", lambda *a, **k: called.append(1) or [])
    r = client.post("/memory/extract", json={"turns": []})
    assert r.json()["facts"] == []
    assert called == []


def test_endpoint_works_without_a_database():
    """保存先が無い人にも効く（端末の中の記憶に入れるため）。"""
    routes = [r for r in main.app.routes if getattr(r, "path", "") == "/memory/extract"]
    assert len(routes) == 1
    deps = str(routes[0].dependant.dependencies)
    assert "require_storage" not in deps
