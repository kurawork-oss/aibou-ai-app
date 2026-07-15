# life.py — ME モード（あなたを知るパートナーAI）のバックエンド。
# 「経験の箱」= life_entries（経歴/お金/人間関係/健康/価値観/出来事）を保管し、
# 相談チャットの system prompt に常に注入する。通常CHATが業務エージェントなのに
# 対し、ME はプライベート込みの人生・お金の相談相手。
# Supabase 未設定ならプロセス内メモリにフォールバック（絶対に crash しない）。
import json
import re
import uuid
from datetime import datetime, timezone

import config

# カテゴリ（UIのタブと対応）
CATEGORIES = [
    {"key": "career", "label": "経歴・仕事"},
    {"key": "money", "label": "お金"},
    {"key": "relationships", "label": "家族・人間関係"},
    {"key": "health", "label": "健康"},
    {"key": "values", "label": "価値観・目標"},
    {"key": "events", "label": "出来事"},
    {"key": "other", "label": "その他"},
]
_CATEGORY_KEYS = {c["key"] for c in CATEGORIES}

# プロンプトに載せる合計上限（長期運用でも溢れない）
MAX_PROFILE_CHARS = 14_000

# Supabase 未設定時のプロセス内フォールバック
_mem_entries: list = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_category(cat: str) -> str:
    c = (cat or "other").strip().lower()
    return c if c in _CATEGORY_KEYS else "other"


def list_entries(category: str = "") -> list:
    """経験の箱の一覧（新しい順）。category 指定で絞り込み。"""
    cat = (category or "").strip().lower()
    c = config.get_supabase()
    if c:
        try:
            q = c.table("life_entries").select("*").order("created_at", desc=True).limit(500)
            if cat:
                q = q.eq("category", cat)
            return q.execute().data or []
        except Exception:
            pass
    items = [e for e in _mem_entries if not cat or e["category"] == cat]
    return sorted(items, key=lambda e: e["created_at"], reverse=True)


def add_entry(category: str, content: str, entry_date: str = "") -> dict:
    """経験を1件保存する。"""
    content = (content or "").strip()
    if not content:
        return {"error": "content is required"}
    row = {
        "id": str(uuid.uuid4()),
        "category": _norm_category(category),
        "content": content[:4_000],
        "entry_date": (entry_date or "").strip()[:32],
        "created_at": _now_iso(),
    }
    c = config.get_supabase()
    if c:
        try:
            c.table("life_entries").insert(row).execute()
            return row
        except Exception:
            pass
    _mem_entries.append(row)
    return row


def delete_entry(entry_id: str) -> dict:
    """経験を1件削除する。"""
    eid = (entry_id or "").strip()
    if not eid:
        return {"error": "id is required"}
    c = config.get_supabase()
    if c:
        try:
            c.table("life_entries").delete().eq("id", eid).execute()
            return {"ok": True}
        except Exception:
            pass
    global _mem_entries
    _mem_entries = [e for e in _mem_entries if e["id"] != eid]
    return {"ok": True}


def build_profile_block() -> str:
    """経験の箱をカテゴリ別にまとめた system prompt 用ブロックを作る。
    上限を超える場合は各カテゴリ新しい順に均等に詰める。"""
    entries = list_entries()
    if not entries:
        return ""
    by_cat: dict = {c["key"]: [] for c in CATEGORIES}
    for e in entries:
        by_cat.setdefault(_norm_category(e.get("category", "other")), []).append(e)

    labels = {c["key"]: c["label"] for c in CATEGORIES}
    parts: list = []
    total = 0
    for key in [c["key"] for c in CATEGORIES]:
        items = by_cat.get(key) or []
        if not items:
            continue
        lines = []
        for e in items:  # list_entries は新しい順
            d = f"（{e['entry_date']}）" if e.get("entry_date") else ""
            line = f"- {d}{(e.get('content') or '').strip()}"
            if total + len(line) > MAX_PROFILE_CHARS:
                lines.append("- （…以降は省略）")
                break
            total += len(line)
            lines.append(line)
        parts.append(f"◆ {labels.get(key, key)}\n" + "\n".join(lines))
    return "\n\n".join(parts)


def build_life_prompt(name: str = "") -> str:
    """ME モードの system prompt（人格＋経験の箱）。"""
    user = (name or "あなた").strip() or "あなた"
    persona = (
        f"あなたは {user} の人生を深く理解している専属パートナーAIです。"
        "長い付き合いの、信頼できる相談相手として振る舞います。\n"
        "【役割】人生・キャリア・お金・人間関係・健康など、プライベートを含む相談に乗る。\n"
        "【姿勢】\n"
        "1. 下の「経験の箱」の内容を前提として常に踏まえ、過去の経緯と現状を理解した上で答える\n"
        "   （「以前◯◯とおっしゃっていた〜」のように、覚えていることを自然に会話へ織り込む）。\n"
        "2. まず気持ちを受け止める。判断や説教はしない。安易な一般論より本人の文脈を優先する。\n"
        "3. その上で、具体的で現実的な選択肢を提示する。必要なら数字で考える（家計・貯蓄・収支など）。\n"
        "4. 情報が足りない時は、決めつけずに1つだけ質問して掘り下げる。\n"
        "5. お金・法律・健康の重大な判断は、最後に専門家への相談も一言添える（くどくならない程度に）。\n"
        "6. 日本語で、温かく、簡潔に。"
    )
    profile = build_profile_block()
    if profile:
        return persona + "\n\n【経験の箱 — " + user + " について覚えていること】\n" + profile
    return (
        persona
        + "\n\n【経験の箱】まだ空です。会話の中で相手のことを知ったら、"
        "自然に聞き返しながら理解を深めてください（保存はユーザーが行います）。"
    )


# ── 会話から経験を抽出（箱への自動提案） ─────────────────────────────
def _extract_json(text: str):
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    s = (m.group(1) if m else text).strip()
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(re.sub(r",\s*([}\]])", r"\1", s[start:i + 1]))
                except Exception:
                    return None
    return None


def extract_entries(turns: list) -> dict:
    """直近の相談会話から「経験の箱」候補を抽出する（保存はユーザー確認後）。"""
    model = config.get_gemini_model()
    if model is None:
        return {"error": "GEMINI_API_KEY が未設定です。Settings → KEYCHAIN で設定してください。"}
    convo = "\n".join(
        f"{'ユーザー' if (t.get('role') == 'user') else 'AI'}: {str(t.get('content') or '')[:800]}"
        for t in (turns or [])[-12:]
    )
    if not convo.strip():
        return {"entries": []}
    cats = " | ".join(c["key"] for c in CATEGORIES)
    prompt = (
        "次の相談会話から、ユーザー本人に関する長期的に覚えておくべき事実・経験・価値観だけを抽出してください。\n"
        "一時的な話題や一般論は含めない。各項目は1文で簡潔に。0〜5件。\n"
        f'出力は次のJSONのみ: {{"entries": [{{"category": "{cats} のいずれか", "content": "…"}}]}}\n\n'
        f"【会話】\n{convo}"
    )
    try:
        resp = config.generate_resilient(prompt)
        obj = _extract_json(getattr(resp, "text", "") or "")
        items = (obj or {}).get("entries") or []
        out = []
        for it in items[:5]:
            content = str((it or {}).get("content") or "").strip()
            if content:
                out.append({"category": _norm_category(str((it or {}).get("category") or "")), "content": content[:500]})
        return {"entries": out}
    except Exception as e:
        return {"error": f"extract failed: {e}"}
