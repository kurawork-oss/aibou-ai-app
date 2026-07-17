# slides.py — スライド資料（プレゼン）の生成
# =====================================================================
# トピックから「見た目のあるスライド構成」を JSON で生成する。
#   deck = {"title": "...", "slides": [{"title": "...", "bullets": ["..."], "notes": "..."}]}
# artifacts に kind="slides"（content=JSON文字列）で保存され、フロントで
# ビジュアルなスライドとして表示・PDF/Googleスライド化できる。
# 設定が欠けても crash せず、フォールバックのデッキを返す。
# =====================================================================

import json
import re

import llm


def _extract_json(text: str):
    """```json ... ``` or 最初の {...} を取り出してパースする。"""
    text = text or ""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = m.group(1) if m else None
    if raw is None:
        s = text.find("{")
        e = text.rfind("}")
        raw = text[s:e + 1] if s != -1 and e > s else None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _normalize(deck, fallback_title: str = "スライド") -> dict:
    """任意の dict をスライド構造に正規化する（壊れた入力にも耐える）。"""
    if not isinstance(deck, dict):
        deck = {}
    title = str(deck.get("title") or fallback_title)[:120]
    out_slides = []
    for s in (deck.get("slides") or [])[:30]:
        if isinstance(s, str):
            out_slides.append({"title": s[:120], "bullets": [], "notes": ""})
            continue
        if not isinstance(s, dict):
            continue
        bullets = s.get("bullets") or s.get("points") or []
        if isinstance(bullets, str):
            bullets = [bullets]
        out_slides.append({
            "title": str(s.get("title") or "")[:120],
            "bullets": [str(b)[:200] for b in bullets if str(b).strip()][:8],
            "notes": str(s.get("notes") or "")[:500],
        })
    if not out_slides:
        out_slides = [{"title": title, "bullets": ["（内容が空です）"], "notes": ""}]
    return {"title": title, "slides": out_slides}


def generate_deck(topic: str, n: int = 6) -> dict:
    """トピックから n 枚程度のスライド構成を生成する。"""
    topic = (topic or "").strip()
    if not topic:
        return {"error": "topic is empty"}
    try:
        n = max(3, min(int(n or 6), 15))
    except Exception:
        n = 6

    prompt = (
        f"あなたはプロのプレゼン作成者です。テーマ「{topic}」について、"
        f"{n}枚程度の分かりやすいスライド構成を作ってください。"
        "各スライドは短い見出しと、2〜5個の簡潔な箇条書きにします。"
        "1枚目はタイトルスライド、最後はまとめにしてください。\n"
        "必ず次の形式のJSONだけを ```json ``` の中に出力（説明文は不要）：\n"
        '```json\n'
        '{"title":"プレゼンのタイトル","slides":[{"title":"見出し","bullets":["要点1","要点2"]}]}\n'
        '```'
    )
    try:
        text = llm.generate_text(prompt, max_tokens=1800)
    except Exception as e:
        return {"error": f"generation failed: {e}"}
    deck = _extract_json(text)
    if not deck:
        # 生成に失敗しても、最低限のデッキを返す（縮退）。
        return _normalize({"title": topic, "slides": [
            {"title": topic, "bullets": ["自動生成に失敗したため簡易版を表示しています"]},
        ]}, topic)
    return _normalize(deck, topic)


def to_markdown(deck: dict) -> str:
    """デッキを Markdown 化する（ドキュメントとして扱いたい時用）。"""
    deck = _normalize(deck)
    lines = [f"# {deck['title']}", ""]
    for i, s in enumerate(deck["slides"], start=1):
        lines.append(f"## {i}. {s['title']}")
        for b in s["bullets"]:
            lines.append(f"- {b}")
        if s.get("notes"):
            lines.append(f"\n> {s['notes']}")
        lines.append("")
    return "\n".join(lines)
