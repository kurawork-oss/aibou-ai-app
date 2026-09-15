# pseo.py — Programmatic SEO（掛け合わせキーワードの大量ページ生成）
# =====================================================================
# 企画書 §3 の「メインキャッシュカウ」。軸（axes）の掛け合わせでニッチな
# ロングテールページを大量に企画し、AIで本文を書いて DB に貯める。
#
#   plan_pages([["ジャンルA","ジャンルB"], ["初心者","中級者"]])
#       → 「ジャンルA × 初心者」…の組み合わせページ計画（slug付き）
#   generate_page(spec) → 見出し/本文/FAQ をAIが執筆（PR表記を必ず付与）
#
# セミオート原則：生成物は status="draft"。承認(approved)したページだけを
# 公開用API/サイトマップに出す（暴走・誤情報の公開を構造的に防ぐ）。
# 他者データのスクレイピングは行わず、自前の軸＋LLMの再構成で作る。
# =====================================================================

import jsonout

import json
import re
import unicodedata
from datetime import datetime, timezone
from itertools import product
from typing import List, Optional

import compliance
import config
import memstore
import llm

MAX_PAGES_PER_PLAN = 200
STATUSES = ("draft", "approved", "rejected")

_mem_pages = memstore.TenantList()   # Supabase 未設定時のフォールバック


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(text: str) -> str:
    """日本語混在でもURLに使える slug を作る（英数はそのまま、それ以外は連結）。"""
    s = unicodedata.normalize("NFKC", (text or "")).strip().lower()
    s = re.sub(r"[\s　/、,]+", "-", s)
    s = re.sub(r"[^\w\-ぁ-んァ-ヶ一-龠ー]", "", s, flags=re.UNICODE)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s[:80] or "page"


def plan_pages(axes: List[List[str]], template: str = "", limit: int = 50) -> List[dict]:
    """軸の掛け合わせでページ計画を作る。{slug, title, keywords} のリスト。"""
    axes = [[str(v).strip() for v in ax if str(v).strip()] for ax in (axes or [])]
    axes = [ax for ax in axes if ax]
    if not axes:
        return []
    limit = max(1, min(int(limit or 50), MAX_PAGES_PER_PLAN))
    out = []
    for combo in product(*axes):
        title = template.format(*combo) if template and "{" in template else " × ".join(combo)
        out.append({
            "slug": slugify(title),
            "title": title[:120],
            "keywords": ", ".join(combo),
        })
        if len(out) >= limit:
            break
    return out


def _extract_json(text: str):
    """AIの出力からJSONを取り出す。読めなければ None。

    中身は jsonout に1本化してある（同じ関数が10か所にあり、崩れ方への
    強さがばらついていたため）。
    """
    return jsonout.extract(text)


def _normalize_content(data, title: str) -> dict:
    """AI出力を安全な形へ正規化し、PR表記を必ず入れる。"""
    if not isinstance(data, dict):
        data = {}
    sections = []
    for s in (data.get("sections") or [])[:8]:
        if isinstance(s, dict) and (s.get("h2") or s.get("body")):
            sections.append({"h2": str(s.get("h2") or "")[:120], "body": str(s.get("body") or "")[:2000]})
    faq = []
    for f in (data.get("faq") or [])[:6]:
        if isinstance(f, dict) and (f.get("q") or f.get("a")):
            faq.append({"q": str(f.get("q") or "")[:200], "a": str(f.get("a") or "")[:1000]})
    lead = str(data.get("lead") or "")[:1000]
    return {
        "disclosure": compliance.disclosure("article"),
        "lead": lead,
        "sections": sections or [{"h2": title, "body": lead or "（本文の生成に失敗しました）"}],
        "faq": faq,
        "meta_description": str(data.get("meta_description") or lead)[:160],
    }


def generate_page(spec: dict) -> dict:
    """1ページ分の本文をAIに書かせる。{slug,title,keywords,content} を返す。"""
    title = str((spec or {}).get("title") or "").strip()
    if not title:
        return {"error": "title is required"}
    keywords = str((spec or {}).get("keywords") or title)
    slug = str((spec or {}).get("slug") or slugify(title))

    prompt = (
        f"あなたは検索意図に寄り添うWebライターです。テーマ「{title}」"
        f"（キーワード: {keywords}）について、読者の悩みを解決する記事を書いてください。\n"
        "手順：まず読者が何に困っているかを考え、次に結論、根拠、具体的な手順の順に構成します。\n"
        "・見出し(h2)は3〜5個、各本文は200〜400字程度\n"
        "・体験の断定や誇張、根拠のない数値は書かない\n"
        "・最後にFAQを2〜3個\n"
        "必ず次の形式のJSONだけを ```json ``` の中に出力：\n"
        '```json\n'
        '{"meta_description":"120字程度の要約","lead":"導入文",'
        '"sections":[{"h2":"見出し","body":"本文"}],'
        '"faq":[{"q":"質問","a":"回答"}]}\n'
        '```'
    )
    try:
        text = llm.generate_text(prompt, max_tokens=2200)
    except Exception as e:
        return {"error": f"generation failed: {e}"}

    content = _normalize_content(_extract_json(text), title)
    return {"slug": slug, "title": title, "keywords": keywords, "content": content}


def save_page(page: dict, status: str = "draft") -> dict:
    """ページを保存（同じslugは上書き）。status は draft/approved/rejected。"""
    slug = str((page or {}).get("slug") or "").strip()
    if not slug:
        return {"error": "slug is required"}
    if status not in STATUSES:
        status = "draft"
    row = {
        "slug": slug,
        "title": str(page.get("title") or "")[:120],
        "keywords": str(page.get("keywords") or "")[:300],
        "content": page.get("content") or {},
        "status": status,
        "updated_at": _now_iso(),
    }
    c = config.get_supabase()
    if c:
        try:
            res = c.table("pseo_pages").upsert(row).execute()
            if res.data:
                return res.data[0]
        except Exception:
            pass
    # 入れ物ごと置き換えると、保存先ごとに分けている意味が消える。
    # その場で削る。
    for _i in range(len(_mem_pages) - 1, -1, -1):
        p = _mem_pages[_i]
        if not (p.get("slug") != slug):
            del _mem_pages[_i]
    _mem_pages.insert(0, row)
    return row


def list_pages(status: Optional[str] = None, limit: int = 200) -> List[dict]:
    """ページ一覧（本文込み）。status で絞り込み可。"""
    c = config.get_supabase()
    if c:
        try:
            q = c.table("pseo_pages").select("*").order("updated_at", desc=True).limit(limit)
            if status:
                q = q.eq("status", status)
            return q.execute().data or []
        except Exception:
            pass
    items = [p for p in _mem_pages if not status or p.get("status") == status]
    return items[:limit]


def get_page(slug: str) -> Optional[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = c.table("pseo_pages").select("*").eq("slug", slug).limit(1).execute().data or []
            if rows:
                return rows[0]
        except Exception:
            pass
    for p in _mem_pages:
        if p.get("slug") == slug:
            return p
    return None


def set_status(slug: str, status: str) -> dict:
    """承認/却下（セミオート運用の要）。"""
    if status not in STATUSES:
        return {"error": f"invalid status: {status}"}
    page = get_page(slug)
    if not page:
        return {"error": "page not found"}
    c = config.get_supabase()
    if c:
        try:
            c.table("pseo_pages").update({"status": status, "updated_at": _now_iso()}).eq("slug", slug).execute()
        except Exception:
            pass
    for p in _mem_pages:
        if p.get("slug") == slug:
            p["status"] = status
            p["updated_at"] = _now_iso()
    return {"ok": True, "slug": slug, "status": status}


def delete_page(slug: str) -> dict:
    # 入れ物ごと置き換えると、保存先ごとに分けている意味が消える。
    # その場で削る。
    for _i in range(len(_mem_pages) - 1, -1, -1):
        p = _mem_pages[_i]
        if not (p.get("slug") != slug):
            del _mem_pages[_i]
    c = config.get_supabase()
    if c:
        try:
            c.table("pseo_pages").delete().eq("slug", slug).execute()
        except Exception:
            pass
    return {"ok": True}


def sitemap() -> List[dict]:
    """公開（承認済み）ページのみのサイトマップ用データ。"""
    return [{"slug": p.get("slug"), "updated_at": p.get("updated_at", "")}
            for p in list_pages("approved", 1000)]


def generate_batch(axes: List[List[str]], template: str = "", limit: int = 5) -> dict:
    """計画→生成→draft保存を一括で行う（cronやUIから叩く入口）。"""
    specs = plan_pages(axes, template, limit)
    if not specs:
        return {"error": "axes が空です"}
    created, failed = [], []
    for spec in specs:
        page = generate_page(spec)
        if page.get("error"):
            failed.append({"slug": spec["slug"], "error": page["error"]})
            continue
        saved = save_page(page, "draft")
        created.append({"slug": saved.get("slug"), "title": saved.get("title")})

    # 1ページも作れなかった場合は「成功0件」ではなく理由を返す（UIが誤解しないように）。
    if not created:
        reason = failed[0]["error"] if failed else "生成に失敗しました"
        if "provider" in reason.lower() or "api" in reason.lower() or "key" in reason.lower():
            reason += "（設定 →「つなぐ」 に GEMINI_API_KEY か HUGGINGFACE_TOKEN を設定してください）"
        return {"error": reason, "created": [], "failed": failed, "count": 0}
    return {"ok": True, "created": created, "failed": failed, "count": len(created)}
