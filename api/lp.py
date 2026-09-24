# lp.py — Webページ / Webアプリの生成（1ファイル完結HTML）
# =====================================================================
# 「作りたいもの」を文章で書くと、そのまま使える 1枚のHTMLを書き上げる。
# 外部CDNに依存しない自己完結HTML（<style>/<script>インライン）にするのが要点で、
# これによりフロントの iframe でそのままライブプレビューでき、
# ダウンロードして任意のサーバーに置くだけで動く。
#
#   kind="lp"  … ランディングページ / ホームページ（見せるためのページ）
#   kind="app" … 動くWebアプリ（入力・保存・計算ができる道具）
#
#   generate(brief, kind=...)                 … 新規生成
#   generate(brief, kind=..., current=html)   … 既存HTMLを指示で改善（反復開発）
#
# 生成物は artifacts に kind="site" / mime="text/html" で保存され、
# HOMEの「生成物」から再表示・ダウンロードできる。
# =====================================================================

import re

import llm

STYLES = {
    "modern": "余白を大きく取り、無彩色ベース＋1色アクセント。今風でクリーンな印象。",
    "bold": "大きな見出しと高コントラスト。力強くインパクト重視。",
    "warm": "丸みのある角、暖色系、やわらかい影。親しみやすく安心感のある印象。",
    "dark": "ダークテーマにネオンのアクセント。テック/ガジェット向け。",
    "minimal": "線とタイポグラフィ中心。装飾を極力省いた上品な印象。",
}

MAX_HTML = 120_000


KINDS = ("lp", "app")

# アプリ生成時の既定の構成（未指定ならこれを使う）
APP_DEFAULT_SPEC = (
    "入力エリア・一覧表示・追加/編集/削除・件数や合計の表示。"
    "データは localStorage に保存して再読込後も残るようにする。"
)

# 両方に共通する「1ファイル完結」の技術要件（iframeプレビューを成立させる要）
_COMMON_RULES = (
    "【厳守する技術要件】\n"
    "・出力は 完全な1ファイルのHTML のみ（<!DOCTYPE html> から </html> まで）\n"
    "・CSSは <style>、JSは <script> にインラインで書く。"
    "外部CSS/JS/フォント/画像URL・CDNは一切使わない（装飾はCSSで表現する）\n"
    "・レスポンシブ（スマホ幅で崩れない。CSS Grid/Flexbox、clamp()でフォント可変）\n"
    "・アクセシビリティ：見出し階層、label、alt、十分なコントラスト\n"
    "・日本語UI。空欄プレースホルダやTODOを残さない\n"
    "説明文やマークダウンのコードフェンスは書かず、HTMLだけを出力してください。"
)


def _system(style: str, sections: str, kind: str = "lp") -> str:
    style_note = STYLES.get(style, STYLES["modern"])
    if kind == "app":
        return (
            "あなたは一流のフロントエンドエンジニアです。"
            "依頼内容から、ブラウザだけで完結して“実際に動く”Webアプリを作ってください。\n"
            + _COMMON_RULES + "\n"
            "【アプリとしての要件】\n"
            "・バックエンド無しで動作する（保存は localStorage、fetchで外部APIを呼ばない）\n"
            "・素のJavaScriptで実装（Reactなどのフレームワークは読み込めないので使わない）\n"
            "・実際に操作できること：入力→保存→再読込しても残る、削除や編集も動く\n"
            "・入力検証とエラー表示、空状態のメッセージも用意する\n"
            "・データを消す操作には確認を入れる\n"
            f"【デザインの方向性】{style_note}\n"
            f"【作るもの・機能】{sections}\n"
        )
    return (
        "あなたは一流のWebデザイナー兼フロントエンド実装者です。"
        "依頼内容から、そのまま公開できる日本語のランディングページを作ってください。\n"
        + _COMMON_RULES + "\n"
        "・JSを使う場合も最小限（スムーススクロールや開閉のみ）\n"
        f"【デザインの方向性】{style_note}\n"
        f"【構成】{sections}\n"
        "【コピー】具体的で誇張しない日本語。\n"
    )


def _extract_html(text: str) -> str:
    """モデル出力からHTML本体を取り出す（```html フェンスや前置きを除去）。"""
    t = (text or "").strip()
    m = re.search(r"```(?:html)?\s*(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    i = t.lower().find("<!doctype")
    if i == -1:
        i = t.lower().find("<html")
    if i > 0:
        t = t[i:]
    j = t.lower().rfind("</html>")
    if j != -1:
        t = t[: j + len("</html>")]
    return t.strip()


def _looks_like_html(html: str) -> bool:
    low = (html or "").lower()
    return "<html" in low and "</html>" in low and len(html) > 300


def generate(brief: str, style: str = "modern", sections: str = "",
             current: str = "", kind: str = "lp") -> dict:
    """ページ/アプリを生成（current があればそれを改善）。{ok, html, title} / {error}。"""
    brief = (brief or "").strip()
    kind = kind if kind in KINDS else "lp"
    if not brief:
        return {"error": "作りたいものの内容（brief）が空です"}
    sections = (sections or "").strip() or (
        APP_DEFAULT_SPEC if kind == "app" else
        "ヒーロー（キャッチコピー＋CTA）／課題提起／提供価値3点／使い方3ステップ／"
        "よくある質問／最後のCTA／フッター"
    )

    if current and _looks_like_html(current):
        prompt = (
            _system(style, sections, kind)
            + "\n\n【既存のHTML】\n" + current[:60_000]
            + "\n\n【修正指示】\n" + brief
            + "\n\n修正後の完全なHTMLを出力してください（差分ではなく全文）。"
              "既にある機能を壊さないこと。"
        )
    else:
        prompt = _system(style, sections, kind) + "\n\n【依頼内容】\n" + brief

    try:
        text = llm.generate_text(prompt, max_tokens=8000)
    except Exception as e:
        return {"error": f"生成に失敗しました: {e}"}

    html = _extract_html(text)
    if not _looks_like_html(html):
        return {"error": "HTMLとして解釈できる出力が得られませんでした。もう一度お試しください。"}
    html = html[:MAX_HTML]

    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    fallback = "Webアプリ" if kind == "app" else "ランディングページ"
    title = (m.group(1).strip() if m else brief[:40]) or fallback
    return {"ok": True, "html": html, "title": title[:120], "kind": kind}


def save_as_artifact(title: str, html: str) -> dict:
    """生成したLPを成果物として保存（「ファイル」の生成物に並ぶ）。"""
    try:
        import artifacts
        return artifacts.create("site", title or "ランディングページ", html, "text/html")
    except Exception as e:
        return {"error": str(e)}
