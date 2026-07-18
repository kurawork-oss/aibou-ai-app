# slides.py — スライド資料（プレゼン）の生成＋デザイン
# =====================================================================
# トピックから「デザインされたスライド構成」を JSON で生成する。
#   deck = {
#     "title": "...", "theme": "midnight",
#     "slides": [{"layout": "title", "title": "...", "subtitle": "...", "image": "url"}, ...]
#   }
# レイアウト: title / section / bullets / two_col / stat / quote / image
# theme はフロントの配色プリセット名。image は英語プロンプト→Pollinations URL に変換。
# 設定が欠けても crash せず、フォールバックのデッキを返す。
# =====================================================================

import json
import re

import llm

THEMES = ["midnight", "aurora", "sunset", "forge", "mono"]
LAYOUTS = ["title", "section", "bullets", "two_col", "stat", "quote", "image"]
MAX_IMAGES = 5  # 1デッキあたりの自動画像枚数の上限


def _extract_json(text: str):
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


def _norm_slide(s) -> dict:
    """1枚のスライドを正規化する（旧形式=bulletsのみ、にも対応）。"""
    if isinstance(s, str):
        return {"layout": "bullets", "title": s[:120], "bullets": []}
    if not isinstance(s, dict):
        return {"layout": "bullets", "title": "", "bullets": []}

    layout = str(s.get("layout") or "").strip().lower()
    if layout not in LAYOUTS:
        layout = "bullets"

    bullets = s.get("bullets") or s.get("points") or []
    if isinstance(bullets, str):
        bullets = [bullets]
    bullets = [str(b)[:200] for b in bullets if str(b).strip()][:8]

    out = {
        "layout": layout,
        "title": str(s.get("title") or "")[:150],
        "bullets": bullets,
        "notes": str(s.get("notes") or "")[:500],
    }
    for k in ("subtitle", "stat", "quote", "author", "image"):
        v = s.get(k)
        if v:
            out[k] = str(v)[:400]
    return out


def _normalize(deck, fallback_title: str = "スライド") -> dict:
    if not isinstance(deck, dict):
        deck = {}
    title = str(deck.get("title") or fallback_title)[:120]
    theme = str(deck.get("theme") or "midnight").strip().lower()
    if theme not in THEMES:
        theme = "midnight"
    slides = [_norm_slide(s) for s in (deck.get("slides") or [])[:30]]
    slides = [s for s in slides if s.get("title") or s.get("bullets") or s.get("quote") or s.get("stat") or s.get("image")]
    if not slides:
        slides = [{"layout": "title", "title": title, "subtitle": "", "bullets": []}]
    return {"title": title, "theme": theme, "slides": slides}


def _apply_images(deck: dict) -> dict:
    """image フィールドが英語プロンプトなら Pollinations URL に変換する（上限あり）。"""
    try:
        import imagegen
    except Exception:
        return deck
    used = 0
    for s in deck.get("slides", []):
        img = s.get("image")
        if not img:
            continue
        if str(img).startswith("http"):
            continue
        if used >= MAX_IMAGES:
            s.pop("image", None)
            continue
        res = imagegen.generate(str(img), 1280, 720)
        if res.get("ok"):
            s["image"] = res["url"]
            used += 1
        else:
            s.pop("image", None)
    return deck


def generate_deck(topic: str, n: int = 6, theme: str = "", with_images: bool = True) -> dict:
    """トピックからデザイン付きのスライド構成を生成する。"""
    topic = (topic or "").strip()
    if not topic:
        return {"error": "topic is empty"}
    try:
        n = max(3, min(int(n or 6), 15))
    except Exception:
        n = 6
    theme = (theme or "").strip().lower()
    theme_hint = theme if theme in THEMES else "内容に合うものを選ぶ"

    prompt = (
        f"あなたはプロのプレゼンデザイナーです。テーマ「{topic}」について、"
        f"{n}枚程度の「デザインされた」スライド構成を作ってください。\n"
        "各スライドに最適な layout を割り当てます：\n"
        "- title: 表紙（title, subtitle, image=表紙背景の英語画像プロンプト）\n"
        "- section: 章の区切り（title）\n"
        "- bullets: 見出し+箇条書き（title, bullets 2〜5個）\n"
        "- two_col: 箇条書きが6個前後と多い時（title, bullets）\n"
        "- stat: 重要な数字を大きく見せる（stat 例\"+30%\", title=その説明）\n"
        "- quote: 引用・キーメッセージ（quote, author）\n"
        "- image: 画像で見せる（title, image=英語画像プロンプト, bullets任意）\n"
        "1枚目は必ず title、最後は section か bullets の『まとめ』。"
        "image は表紙と image レイアウトのみ、短い英語プロンプトにする（多用しない）。\n"
        f"theme は次から1つ選ぶ: {', '.join(THEMES)}（{theme_hint}）。\n"
        "必ず次の形式のJSONだけを ```json ``` の中に出力：\n"
        '```json\n'
        '{"title":"タイトル","theme":"midnight","slides":['
        '{"layout":"title","title":"...","subtitle":"...","image":"..."},'
        '{"layout":"bullets","title":"...","bullets":["..."]}]}\n'
        '```'
    )
    try:
        text = llm.generate_text(prompt, max_tokens=2200)
    except Exception as e:
        return {"error": f"generation failed: {e}"}
    deck = _extract_json(text)
    if not deck:
        deck = {"title": topic, "theme": theme or "midnight", "slides": [
            {"layout": "title", "title": topic, "subtitle": "自動生成の簡易版"},
        ]}
    deck = _normalize(deck, topic)
    if theme in THEMES:
        deck["theme"] = theme
    if with_images:
        deck = _apply_images(deck)
    return deck


def to_markdown(deck: dict) -> str:
    """デッキを Markdown 化する（ドキュメントとして扱いたい時用）。"""
    deck = _normalize(deck)
    lines = [f"# {deck['title']}", ""]
    for i, s in enumerate(deck["slides"], start=1):
        head = s.get("title") or s.get("quote") or s.get("stat") or "(無題)"
        lines.append(f"## {i}. {head}")
        if s.get("subtitle"):
            lines.append(f"*{s['subtitle']}*")
        for b in s.get("bullets", []):
            lines.append(f"- {b}")
        if s.get("author"):
            lines.append(f"— {s['author']}")
        if s.get("notes"):
            lines.append(f"\n> {s['notes']}")
        lines.append("")
    return "\n".join(lines)
