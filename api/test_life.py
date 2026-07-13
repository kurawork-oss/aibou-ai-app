# test_life.py — ME モード（life.py + /life/*）のテスト。Gemini/Supabase 不要。
import life
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def setup_function():
    life._mem_entries.clear()


# ── 経験の箱 CRUD（メモリフォールバック） ────────────────────────────
def test_add_list_delete_entry():
    r = life.add_entry("money", "毎月の貯蓄目標は5万円", "2026-07")
    assert r["category"] == "money" and "id" in r
    items = life.list_entries()
    assert len(items) == 1 and items[0]["content"].startswith("毎月")
    assert life.list_entries("money")
    assert life.list_entries("career") == []
    assert life.delete_entry(r["id"])["ok"] is True
    assert life.list_entries() == []


def test_add_entry_validates():
    assert "error" in life.add_entry("money", "")
    r = life.add_entry("invalid-cat", "x")
    assert r["category"] == "other"  # 未知カテゴリはotherへ正規化


def test_profile_block_groups_by_category():
    life.add_entry("career", "2020年にIT企業へ転職")
    life.add_entry("money", "住宅ローンが残り2000万円")
    block = life.build_profile_block()
    assert "経歴・仕事" in block and "お金" in block
    assert "転職" in block and "2000万円" in block


def test_life_prompt_includes_profile_and_persona():
    life.add_entry("values", "家族との時間を最優先したい")
    p = life.build_life_prompt("来希")
    assert "来希" in p and "経験の箱" in p and "家族との時間" in p
    assert "専門家" in p  # 重大判断の注意書き


def test_life_prompt_empty_box():
    p = life.build_life_prompt("")
    assert "まだ空" in p


# ── エンドポイント ───────────────────────────────────────────────────
def test_entries_endpoints_roundtrip():
    r = client.post("/life/entries", json={"category": "health", "content": "週2でジムに通っている"})
    assert r.status_code == 200
    eid = r.json()["id"]
    r2 = client.get("/life/entries")
    assert any(e["id"] == eid for e in r2.json()["items"])
    assert r2.json()["categories"][0]["key"] == "career"
    r3 = client.delete(f"/life/entries/{eid}")
    assert r3.json()["ok"] is True


def test_entries_endpoint_validates():
    r = client.post("/life/entries", json={"category": "money", "content": ""})
    assert r.status_code == 400


def test_life_chat_without_gemini_sse_error():
    r = client.post("/life/chat", json={"message": "最近お金が不安で…"})
    assert r.status_code == 200
    assert "error" in r.text and "done" in r.text


def test_life_extract_without_gemini_503():
    r = client.post("/life/extract", json={"turns": [{"role": "user", "content": "転職を考えている"}]})
    assert r.status_code == 503


def test_extract_json_helper():
    assert life._extract_json('{"entries": []}') == {"entries": []}
    assert life._extract_json('```json\n{"a":1}\n```') == {"a": 1}
    assert life._extract_json("なし") is None
