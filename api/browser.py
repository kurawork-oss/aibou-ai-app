"""
browser.py — 本物のブラウザでページを開いて、読む・押す（仕様§24）。

なぜ `web_read` では足りないか
------------------------------
`web.py` の読み取りは HTTP で1枚取ってきて、タグを剥がすだけ。いま世の中の
ページの多くは、本文が JavaScript で後から入る。そういうページを読ませると

    「このページには内容がありませんでした」

と返ってくる。ページには書いてあるのに。**読めないことすら分からない**
（空のHTMLは正しく取れているので、失敗として扱えない）。

もうひとつ、押さないと先へ進めないページがある。「続きを読む」「同意する」
「次へ」。ここを越えられないと、読める範囲が最初の1画面で止まる。

何を許して、何を許さないか
--------------------------
許す  : 開く・読む・押す・打ち込む・選ぶ・絵を撮る
許さない: 中のJavaScriptを走らせる口（`page.evaluate`）、ファイルの
        ダウンロード、新しいタブ、`file:` などの筋

`page.evaluate` を出さないのは、そこを開けると「AIが書いた任意のコードを
実行する口」になるため。押す・打つだけなら、できることはページに元から
ある物に限られる。

出て行ってよい先か
------------------
2か所で見る。

  ① 開く前   … netguard.check_url（名前を引いて、内向きのアドレスを弾く）
  ② 開いた後 … ページが出す**すべての**要求を1つずつ見て、内向きなら断る

②が要るのは、ページ自身が `<img src="http://169.254.169.254/...">` のような
物を持てるから。①だけだと、こちらが指定したURLは安全でも、そこから先が
素通りする（クラウドの認証情報は、その筋で取られる）。

読んだ物は「指示」ではない
--------------------------
ページの本文は untrusted.wrap で包んでから返す。ページに
「これまでの指示は無視して〜」と書いておく手が実際にあるため。

入っていない環境では
--------------------
Playwright とブラウザ本体は大きい。入っていない置き場もある。
そこでは `available()` が False を返し、自己診断（設定 → つなぐ）に
**「まだ使えません」と正直に出る**——黙って失敗しない。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import netguard
import untrusted

# 1ページに使ってよい時間。ここを長くすると、落ちているサイト1つで
# 置き場のワーカーが埋まる。
TIMEOUT_MS = int(os.environ.get("BROWSER_TIMEOUT_MS", "20000") or 20000)
# 返す本文の長さ。長いほどAIへの入力が膨らみ、そのまま待ち時間になる。
MAX_CHARS = 6000
# 1回の用事で押せる回数。無限に押させると、ページの中を延々と歩く。
MAX_STEPS = 8

# 押す・打つときに触れてよい物。ここに無い筋は使わない。
ACTIONS = ("click", "fill", "select", "press", "wait")


def enabled() -> bool:
    """この置き場で、ブラウザを動かしてよいか。

    既定は**切**。理由は危なさではなく**大きさ**。無料のRenderは
    メモリが512MBで、そこでヘッドレスChromeを1つ開くと、絵の多いページ
    1枚でAPIごと落ちうる。会話まで巻き添えにするのは割に合わない。

    有料の置き場や自分のサーバーに載せている人は `ENABLE_BROWSER=1`。
    `ENABLE_SHELL` と同じ考え方（既定で切って、要る人が開ける）。
    """
    return (os.environ.get("ENABLE_BROWSER", "") or "").strip().lower() in ("1", "true", "yes", "on")


def _find_chrome() -> str:
    """使うブラウザの実体。見つからなければ空文字。

    `BROWSER_EXECUTABLE` があればそれ。無ければ playwright が置いた物を
    探す。**版の番号は見ない**——ここで厳密に合わせようとすると、
    Node側で入れたブラウザが手元にあるのに「入っていません」と言うことに
    なる（実際そうなった）。
    """
    named = (os.environ.get("BROWSER_EXECUTABLE", "") or "").strip()
    if named:
        return named if os.path.exists(named) else ""
    import glob
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "") or \
        os.path.expanduser("~/.cache/ms-playwright")
    for pattern in ("chromium-*/chrome-linux*/chrome", "chromium-*/chrome-linux*/headless_shell",
                    "chromium_headless_shell-*/chrome-linux*/headless_shell"):
        hits = sorted(glob.glob(os.path.join(root, pattern)))
        if hits:
            return hits[-1]
    return ""


def _why_unavailable() -> str:
    """使えないなら、その理由。使えるなら空文字。"""
    if not enabled():
        return ("この置き場ではブラウザ操作を切ってあります"
                "（メモリを使うため既定は切。ENABLE_BROWSER=1 で入ります）")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return "この置き場にはブラウザが入っていません（playwright 未導入）"
    if not _find_chrome():
        return "ブラウザの実体が見つかりません（playwright install chromium）"
    return ""


def available() -> bool:
    return not _why_unavailable()


def status() -> dict:
    why = _why_unavailable()
    return {
        "ok": not why,
        "why": why,
        "enabled": enabled(),
        "timeout_ms": TIMEOUT_MS,
        # 何ができるかを、名前で出す（画面の自己診断が並べる）
        "actions": list(ACTIONS),
    }


def _guard(route, request) -> None:
    """ページが出す要求を1つずつ見る。内向きなら断る。

    ここが無いと、ページ自身が持っている
    `<img src="http://169.254.169.254/latest/meta-data/">` のような物が
    素通りする。こちらが指定したURLが安全でも、そこから先は別の話。
    """
    ok, _why, _ips = netguard.check_url(request.url)
    if ok:
        route.continue_()
    else:
        route.abort()


def _text_of(page, limit: int = MAX_CHARS) -> str:
    """見えている本文。`innerText` を使う（タグ剥がしより素直に読める）。"""
    try:
        body = page.locator("body").inner_text(timeout=5000)
    except Exception:
        body = ""
    body = "\n".join(line.strip() for line in (body or "").splitlines() if line.strip())
    return body[:limit]


def _links(page, limit: int = 30) -> List[dict]:
    """押せる物の一覧。AIが次に何を押せるかを決めるために要る。"""
    out: List[dict] = []
    try:
        for el in page.locator("a[href], button, input[type=submit]").all()[:limit * 3]:
            try:
                label = (el.inner_text(timeout=500) or "").strip()
            except Exception:
                label = ""
            if not label:
                try:
                    label = (el.get_attribute("aria-label") or "").strip()
                except Exception:
                    label = ""
            if not label:
                continue
            href = ""
            try:
                href = el.get_attribute("href") or ""
            except Exception:
                pass
            out.append({"label": label[:80], "href": href[:300]})
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out


def _do(page, step: dict) -> str:
    """1手ぶん。何をしたかを文で返す（できなければ理由を返す）。"""
    kind = str(step.get("do") or "").strip().lower()
    target = str(step.get("target") or "").strip()
    value = str(step.get("value") or "")
    if kind not in ACTIONS:
        return f"（{kind or '空'}）は使えません"
    try:
        if kind == "wait":
            page.wait_for_timeout(min(int(value or 1000), 5000))
            return "待ちました"
        if kind == "press":
            page.keyboard.press(target or "Enter")
            return f"{target or 'Enter'} を押しました"
        # 文字で探す（AIが CSS を書くより、人が読む言葉のほうが当たる）
        el = page.get_by_text(target, exact=False).first if target else None
        if el is None:
            return "どこを触るのか分かりません"
        if kind == "click":
            el.click(timeout=5000)
            return f"「{target}」を押しました"
        if kind == "fill":
            page.get_by_label(target).first.fill(value, timeout=5000)
            return f"「{target}」に入力しました"
        if kind == "select":
            page.get_by_label(target).first.select_option(value, timeout=5000)
            return f"「{target}」で{value}を選びました"
    except Exception as e:
        return f"できませんでした（{type(e).__name__}）"
    return "何もしませんでした"


def visit(url: str, steps: Optional[List[dict]] = None,
          max_chars: int = MAX_CHARS) -> Dict[str, Any]:
    """ページを開いて、（あれば）手順を順に行い、見えている本文を返す。

    **例外は出さない。** 読めなかったら、読めなかったと書いて返す。
    """
    why = _why_unavailable()
    if why:
        return {"ok": False, "error": why, "text": "", "title": "", "url": url}

    ok, reason, _ips = netguard.check_url(url)
    if not ok:
        return {"ok": False, "error": reason, "text": "", "title": "", "url": url}

    plan = [s for s in (steps or []) if isinstance(s, dict)][:MAX_STEPS]
    did: List[str] = []
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=_find_chrome() or None,
                args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"])
            try:
                ctx = browser.new_context(
                    locale="ja-JP",
                    # ダウンロードは受け取らない（置き場のディスクを埋めない）
                    accept_downloads=False,
                )
                ctx.set_default_timeout(TIMEOUT_MS)
                ctx.route("**/*", _guard)
                page = ctx.new_page()
                # 新しいタブは開かせない。開かせると、そのタブは門番の
                # 外側に出る（route を張り直すまでの間が空く）。
                ctx.on("page", lambda p: p.close())
                page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT_MS)
                for step in plan:
                    did.append(_do(page, step))
                try:
                    page.wait_for_load_state("networkidle", timeout=3000)
                except Exception:
                    pass
                title = (page.title() or "")[:200]
                body = _text_of(page, max_chars)
                links = _links(page)
                final = page.url
            finally:
                browser.close()
    except Exception as e:
        return {"ok": False, "error": f"開けませんでした（{type(e).__name__}）",
                "text": "", "title": "", "url": url, "did": did}

    if not body.strip():
        return {"ok": False, "error": "ページは開けましたが、本文が空でした",
                "text": "", "title": title, "url": final, "did": did, "links": links}

    return {
        "ok": True,
        "title": title,
        "url": final,
        # ページの本文は**指示ではない**。包んでから返す。
        "text": untrusted.wrap(body, source=final, kind="ページ"),
        "links": links,
        "did": did,
        "chars": len(body),
    }
