# web.py — Web検索 / ページ読み取り（キー不要・無料）
# =====================================================================
# web_search : DuckDuckGo の HTML エンドポイントを叩いて結果を抽出（APIキー不要）。
# web_read   : URL を取得して本文テキストへ整形（タグ除去）。
# requests だけで実装。取得失敗しても crash せず {ok:False, error} を返す。
# =====================================================================

import html as html_lib
import re
from urllib.parse import unquote, urlparse

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

_RESULT_RE = re.compile(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_SNIPPET_RE = re.compile(r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<(script|style|noscript|template)[^>]*>.*?</\1>", re.S | re.I)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_NL_RE = re.compile(r"\n\s*\n\s*\n+")


def _strip_tags(s: str) -> str:
    return html_lib.unescape(_TAG_RE.sub("", s or "")).strip()


def _real_url(href: str) -> str:
    """DuckDuckGo のリダイレクト(/l/?uddg=...)から実URLを取り出す。"""
    if href.startswith("//"):
        href = "https:" + href
    m = re.search(r"[?&]uddg=([^&]+)", href)
    if m:
        return unquote(m.group(1))
    return href


def web_search(query: str, n: int = 5) -> dict:
    """DuckDuckGo で検索し、上位結果 [{title, url, snippet}] を返す。"""
    query = (query or "").strip()
    if not query:
        return {"ok": False, "error": "検索クエリが空です"}
    if requests is None:
        return {"ok": False, "error": "requests が利用できません"}
    n = max(1, min(int(n or 5), 10))
    try:
        r = requests.post("https://html.duckduckgo.com/html/",
                          data={"q": query}, headers={"User-Agent": _UA}, timeout=20)
        page = r.text or ""
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

    links = _RESULT_RE.findall(page)
    snippets = _SNIPPET_RE.findall(page)
    results = []
    for i, (href, title) in enumerate(links[:n]):
        results.append({
            "title": _strip_tags(title),
            "url": _real_url(href),
            "snippet": _strip_tags(snippets[i]) if i < len(snippets) else "",
        })
    if not results:
        return {"ok": False, "error": "検索結果を取得できませんでした（時間をおいて再試行してください）"}
    return {"ok": True, "results": results}


def web_read(url: str, max_chars: int = 4000) -> dict:
    """URL を取得して本文テキストを返す。{ok, title, text, url}。"""
    url = (url or "").strip()
    if not url:
        return {"ok": False, "error": "URLが空です"}
    if not re.match(r"^https?://", url):
        url = "https://" + url
    if requests is None:
        return {"ok": False, "error": "requests が利用できません"}
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return {"ok": False, "error": "http(s) のURLのみ対応します"}
        r = requests.get(url, headers={"User-Agent": _UA}, timeout=20)
        page = r.text or ""
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}

    tm = _TITLE_RE.search(page)
    title = _strip_tags(tm.group(1)) if tm else ""
    body = _SCRIPT_RE.sub(" ", page)
    body = re.sub(r"</(p|div|br|li|h[1-6]|tr)>", "\n", body, flags=re.I)
    text = html_lib.unescape(_TAG_RE.sub("", body))
    text = _WS_RE.sub(" ", text)
    text = _NL_RE.sub("\n\n", text).strip()
    return {"ok": True, "title": title, "text": text[:max_chars], "url": url}
