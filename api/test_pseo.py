# test_pseo.py — Programmatic SEO + コンプライアンス（PR表記・配信ゲート）のテスト

from fastapi.testclient import TestClient

import compliance
import config
import pseo
from main import app

client = TestClient(app)


def _clear():
    for p in list(pseo.list_pages(None, 1000)):
        pseo.delete_page(p["slug"])


# ── compliance ───────────────────────────────────────────────────────
def test_disclosure_added_once():
    body = compliance.with_disclosure("本文です")
    assert compliance.DISCLOSURE in body and body.startswith(">")
    # 二重付与しない
    assert compliance.with_disclosure(body).count("プロモーションが含まれています") == 1


def test_disclosure_video_variant():
    assert "本動画" in compliance.with_disclosure("説明", "video")


def test_has_disclosure():
    assert compliance.has_disclosure(compliance.with_disclosure("x")) is True
    assert compliance.has_disclosure("ただの本文") is False


def test_gate_blocks_ai_content_on_shutterstock():
    """Shutterstockの投稿者規約はAI生成物を認めていない → 送信させない。"""
    g = compliance.gate("shutterstock", ai_generated=True)
    assert g["ok"] is False and "AI生成" in g["reason"]


def test_gate_allows_own_site_and_note():
    assert compliance.gate("pseo", True)["ok"] is True
    assert compliance.gate("note", True)["ok"] is True


def test_gate_unknown_platform_is_conservative():
    assert compliance.gate("tiktok", True)["ok"] is False


def test_platform_policy_marks_auto_post_off():
    """セミオート原則：どの送信先も自動公開はしない。"""
    for p in ("note", "youtube", "pseo"):
        assert compliance.platform_policy(p)["auto_post"] is False


def test_polite_delay_returns_without_sleeping():
    d = compliance.polite_delay(1, 2, sleep=False)
    assert 1 <= d <= 2


# ── plan（掛け合わせ） ───────────────────────────────────────────────
def test_plan_pages_combinations():
    specs = pseo.plan_pages([["筋トレ", "ヨガ"], ["初心者", "自宅"]])
    titles = [s["title"] for s in specs]
    assert len(specs) == 4
    assert "筋トレ × 初心者" in titles and "ヨガ × 自宅" in titles
    assert all(s["slug"] for s in specs)


def test_plan_pages_template_and_limit():
    specs = pseo.plan_pages([["東京", "大阪"], ["安い"]], template="{1}{0}のジム", limit=1)
    assert len(specs) == 1 and specs[0]["title"] == "安い東京のジム"


def test_plan_pages_empty_axes():
    assert pseo.plan_pages([]) == []


def test_slugify_handles_japanese_and_symbols():
    assert pseo.slugify("筋トレ × 初心者!!") == "筋トレ-初心者"
    assert pseo.slugify("  Hello World  ") == "hello-world"


# ── generate（本文生成） ─────────────────────────────────────────────
def test_generate_page_includes_disclosure(monkeypatch):
    monkeypatch.setattr(pseo.llm, "generate_text", lambda p, **k:
                        '```json\n{"meta_description":"要約","lead":"導入","sections":[{"h2":"見出し","body":"本文"}],"faq":[{"q":"Q","a":"A"}]}\n```')
    page = pseo.generate_page({"title": "筋トレ × 初心者", "keywords": "筋トレ, 初心者"})
    assert page["content"]["sections"][0]["h2"] == "見出し"
    assert page["content"]["faq"][0]["q"] == "Q"
    # ステマ規制対応の表記が必ず入る
    assert compliance.has_disclosure(page["content"]["disclosure"])


def test_generate_page_bad_output_degrades(monkeypatch):
    monkeypatch.setattr(pseo.llm, "generate_text", lambda p, **k: "JSONではない文章")
    page = pseo.generate_page({"title": "テーマ"})
    assert page["content"]["sections"]  # 空にならない
    assert compliance.has_disclosure(page["content"]["disclosure"])


def test_generate_page_requires_title():
    assert pseo.generate_page({}).get("error")


# ── store / 承認フロー ───────────────────────────────────────────────
def test_save_defaults_to_draft_and_approval_flow(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    _clear()
    pseo.save_page({"slug": "a-b", "title": "A × B", "content": {"lead": "x"}})
    assert pseo.get_page("a-b")["status"] == "draft"
    # 未承認はサイトマップに出ない（＝公開されない）
    assert pseo.sitemap() == []
    pseo.set_status("a-b", "approved")
    assert [s["slug"] for s in pseo.sitemap()] == ["a-b"]
    pseo.set_status("a-b", "rejected")
    assert pseo.sitemap() == []
    _clear()


def test_set_status_validates(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    _clear()
    pseo.save_page({"slug": "s1", "title": "T"})
    assert pseo.set_status("s1", "published").get("error")
    assert pseo.set_status("missing", "approved").get("error")
    _clear()


def test_generate_batch_all_failed_reports_error(monkeypatch):
    """AI未設定などで1ページも作れない時は count:0 の成功ではなく error を返す。"""
    monkeypatch.setattr(config, "get_supabase", lambda: None)

    def boom(prompt, **k):
        raise RuntimeError("no AI provider configured")

    monkeypatch.setattr(pseo.llm, "generate_text", boom)
    _clear()
    res = pseo.generate_batch([["犬"], ["しつけ"]], limit=1)
    assert res["count"] == 0 and res.get("error")
    assert "つなぐ" in res["error"]  # 対処法を案内する
    _clear()


def test_generate_batch(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    monkeypatch.setattr(pseo.llm, "generate_text", lambda p, **k:
                        '{"lead":"L","sections":[{"h2":"H","body":"B"}],"faq":[]}')
    _clear()
    res = pseo.generate_batch([["犬", "猫"], ["しつけ"]], limit=2)
    assert res["count"] == 2 and not res["failed"]
    assert all(p["status"] == "draft" for p in pseo.list_pages())
    _clear()


# ── エンドポイント ───────────────────────────────────────────────────
def test_pseo_endpoints_flow(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    monkeypatch.setattr(pseo.llm, "generate_text", lambda p, **k:
                        '{"lead":"L","sections":[{"h2":"H","body":"B"}],"faq":[]}')
    _clear()
    # 計画（プレビュー）
    r = client.post("/pseo/plan", json={"axes": [["ラン", "自転車"], ["初心者"]], "limit": 2})
    assert r.status_code == 200 and len(r.json()["items"]) == 2
    # 生成（draft）
    r2 = client.post("/pseo/generate", json={"axes": [["ラン"], ["初心者"]], "limit": 1})
    assert r2.status_code == 200 and r2.json()["count"] == 1
    slug = r2.json()["created"][0]["slug"]
    # 一覧・承認
    assert any(p["slug"] == slug for p in client.get("/pseo/pages").json()["items"])
    assert client.patch(f"/pseo/pages/{slug}", json={"status": "approved"}).status_code == 200
    # 公開API（承認済みのみ）
    pub = client.get(f"/pseo/public/{slug}")
    assert pub.status_code == 200 and pub.json()["title"]
    assert any(s["slug"] == slug for s in client.get("/pseo/sitemap").json()["items"])
    # 削除
    assert client.delete(f"/pseo/pages/{slug}").status_code == 200
    _clear()


def test_public_page_hidden_until_approved(monkeypatch):
    monkeypatch.setattr(config, "get_supabase", lambda: None)
    _clear()
    pseo.save_page({"slug": "hidden", "title": "H", "content": {"lead": "x"}})
    assert client.get("/pseo/public/hidden").status_code == 404  # draft は非公開
    pseo.set_status("hidden", "approved")
    assert client.get("/pseo/public/hidden").status_code == 200
    _clear()
