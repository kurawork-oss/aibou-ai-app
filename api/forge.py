# forge.py — Forge（生成）ロジック。Geminiで アプリ/画像/スライド/表/文書 を作る。
# Streamlit版 Forge Lab と同じ系統のプロンプトを、API用に移植（自己完結）。
import re
import urllib.parse

import config

# 各タイプのシステムプロンプト（Streamlit Forge Lab と同等の方針）
_APP = (
    "あなたは世界トップクラスのStreamlitアプリ開発者です。要望から、見た目も美しくバグのない"
    "完全な単一ファイルのPythonコードを書きます。`st.set_page_config`/`st.sidebar`/`st.chat_input` は"
    "使用禁止（親画面を壊すため）。コードは省略せず最後まで出力。\n"
    "出力は必ず ```python ... ``` のコードフェンス内に。続けて日本語で次の拡張案を3つ。"
)
_SLIDE = (
    "あなたは一流のプレゼン戦略家です。テーマから論理的で説得力あるスライド構成をMarkdownで作ります。"
    "スライドの区切りは必ず `---`（ハイフン3つ）のみ。各スライドは見出し(#)＋箇条書き(-)。"
    "最後に日本語でトークのヒントを添える。"
)
_SHEET = (
    "あなたは一流のデータアナリストです。要望から実用的な表データを設計し、必ず ```csv ... ``` の"
    "コードフェンス内にCSV（先頭行ヘッダー）で出力します。数値は計算可能な生の値。5〜30行程度。"
    "その後に日本語で使い方を簡潔に。"
)
_DOC = (
    "あなたはプロのビジネスライターです。要望から、見出し(#,##,###)・箇条書き・太字・表・引用を"
    "適切に使った、そのまま提出できる完成度の文書をMarkdownで書きます。省略はしない。文書本体のみ出力。"
)
_IMAGE = (
    "あなたは画像生成AIのプロンプトエンジニアです。日本語の要望から、最高品質の画像を引き出す"
    "緻密な英語プロンプト（主題・媒体・環境・照明・カメラ・スタイルをカンマ区切り）を作り、"
    "必ず [IMAGE_PROMPT: ここに英語] の形式で出力してください。"
)


def _gen_text(system: str, prompt: str) -> str:
    model = config.get_gemini_model()
    if model is None:
        raise RuntimeError("GEMINI_API_KEY is not configured")
    resp = model.generate_content(system + "\n\n【要望】\n" + (prompt or ""))
    return getattr(resp, "text", "") or ""


def generate(kind: str, prompt: str) -> dict:
    """kind: app|slides|sheet|doc|image。生成物を dict で返す（失敗時は error キー）。"""
    kind = (kind or "app").lower()

    # 画像：Geminiで英語プロンプト化 → Pollinations(無料・キー不要)のURLを返す
    if kind == "image":
        eng = (prompt or "").strip()
        try:
            text = _gen_text(_IMAGE, prompt)
            m = re.search(r"\[IMAGE_PROMPT:\s*(.*?)\]", text, re.DOTALL)
            eng = (m.group(1).strip() if m else text.strip()) or eng
        except Exception:
            pass  # キー無し等。素の要望をそのままプロンプトに使う
        url = (
            "https://image.pollinations.ai/prompt/"
            + urllib.parse.quote(eng or "cinematic scene")
            + "?width=1024&height=576&nologo=true"
        )
        return {"kind": "image", "image_url": url, "image_prompt": eng}

    try:
        if kind == "app":
            text = _gen_text(_APP, prompt)
            m = re.search(r"```python\n(.*?)\n```", text, re.DOTALL)
            code = m.group(1) if m else text
            note = text.replace(m.group(0), "").strip() if m else ""
            return {"kind": "app", "code": code, "note": note}
        if kind == "sheet":
            text = _gen_text(_SHEET, prompt)
            m = re.search(r"```csv\n(.*?)\n```", text, re.DOTALL)
            csv = (m.group(1).strip() if m else text.strip())
            note = text.replace(m.group(0), "").strip() if m else ""
            return {"kind": "sheet", "csv": csv, "note": note}
        if kind in ("slides", "slide"):
            return {"kind": "slides", "markdown": _gen_text(_SLIDE, prompt)}
        if kind == "doc":
            return {"kind": "doc", "markdown": _gen_text(_DOC, prompt)}
        # 不明なkindはアプリ扱い
        text = _gen_text(_APP, prompt)
        m = re.search(r"```python\n(.*?)\n```", text, re.DOTALL)
        return {"kind": "app", "code": m.group(1) if m else text, "note": ""}
    except Exception as e:
        return {"kind": kind, "error": f"generation failed: {e}"}
