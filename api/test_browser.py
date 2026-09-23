"""
ブラウザ操作（browser.py / 仕様§24）を見張る。

なぜ足したのか
--------------
`web_read` は HTTP で1枚取ってタグを剥がすだけ。いま世の中のページの多くは
本文をJavaScriptで後から入れるので、そういうページは

    「このページには内容がありませんでした」

と返ってくる。ページには書いてあるのに、**読めないことすら分からない**
（空のHTMLは正しく取れているので、失敗として扱えない）。

ここで守りたいこと
------------------
1. 入っていない置き場で、黙って失敗しない（理由を返す）
2. 内向きのアドレスへ出て行かない——**ページの中の物も含めて**
3. 読んだ本文を「指示」として扱わない
4. 中のJavaScriptを走らせる口を出さない
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser
import risk


# ── 入っていない置き場で、黙らない ──────────────────────────────────

def test_off_by_default(monkeypatch):
    """既定は切。危ないからではなく、512MBの置き場では落ちるから。"""
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    assert browser.enabled() is False
    assert browser.available() is False
    assert "ENABLE_BROWSER" in browser.status()["why"]


def test_says_why_instead_of_crashing(monkeypatch):
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    got = browser.visit("https://example.com")
    assert got["ok"] is False
    assert got["error"]
    assert got["text"] == ""


def test_self_check_lists_it_honestly():
    import capability_status
    row = [c for c in capability_status.GROUPS if c["id"] == "browser"]
    assert len(row) == 1
    assert row[0]["kind"] == "off"
    assert row[0]["env"] == "ENABLE_BROWSER"
    assert "browser_act" in row[0]["tools"]
    # 切ってあっても、ログインが要るサイトは手元の相棒が開くと言う
    # （「ブラウザは使えません」とだけ出すと、本当は使えるのに諦めさせる）
    assert "手元のパソコン" in row[0]["next"]


# ── 出て行ってよい先か ──────────────────────────────────────────────

@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/admin",
    "file:///etc/passwd",
    "http://user:pw@example.com/",
])
def test_inside_addresses_are_refused(monkeypatch, url):
    """開く前に名前を引いて弾く。ブラウザは1つも立ち上げない。"""
    monkeypatch.setenv("ENABLE_BROWSER", "1")
    got = browser.visit(url)
    assert got["ok"] is False
    assert got["text"] == ""


def test_the_page_itself_cannot_reach_inside(monkeypatch):
    """ページの中の要求も1つずつ見る。

    ①（開く前の検査）だけだと、こちらが指定したURLは安全でも、
    ページが持っている `<img src="http://169.254.169.254/...">` が素通りする。
    クラウドの認証情報は、その筋で取られる。
    """
    seen = []

    class FakeRoute:
        def continue_(self): seen.append("continue")
        def abort(self): seen.append("abort")

    class FakeReq:
        def __init__(self, url): self.url = url

    browser._guard(FakeRoute(), FakeReq("https://example.com/a.png"))
    browser._guard(FakeRoute(), FakeReq("http://169.254.169.254/latest/meta-data/"))
    assert seen == ["continue", "abort"]


# ── 何をさせないか ──────────────────────────────────────────────────

def test_no_way_to_run_javascript():
    """`evaluate` を出すと「AIが書いた任意のコードを実行する口」になる。"""
    src = open(os.path.join(os.path.dirname(__file__), "browser.py")).read()
    assert ".evaluate(" not in src
    assert "evaluate" not in browser.ACTIONS


def test_only_the_listed_actions_are_accepted():
    assert set(browser.ACTIONS) == {"click", "fill", "select", "press", "wait"}
    # 知らない筋は、何もせずに理由を返す
    assert "使えません" in browser._do(None, {"do": "evaluate", "target": "x"})
    assert "使えません" in browser._do(None, {"do": "download", "target": "x"})


def test_steps_are_capped(monkeypatch):
    """無限に押させると、ページの中を延々と歩く。"""
    assert browser.MAX_STEPS <= 10


# ── 読んだ物は「指示」ではない ──────────────────────────────────────

def test_body_is_wrapped_as_untrusted():
    """ページに「これまでの指示は無視して〜」と書いておく手が実際にある。"""
    import inspect
    src = inspect.getsource(browser.visit)
    assert "untrusted.wrap" in src


def test_chain_confirmation_covers_the_browser():
    """1枚読んだ後の行き先は、ページ由来かもしれない。web_read と同じ扱い。

    公開ページ（段階0）でも、連鎖では聞く。段階ではなく「誰が決めたか」の話。
    """
    public = {"url": "https://example.com/"}
    for tool in ("browser_open", "browser_act"):
        assert tool in risk.CHAIN_AFTER_EXTERNAL
        assert risk.needs_confirmation(tool, False, external_reads=1, params=public) is True
        assert risk.may_always_allow(tool, external_reads=1, params=public) is False


def test_it_is_registered_as_a_tool():
    import tools
    import toolschema
    for tool in ("browser_open", "browser_act"):
        assert tool in tools.TOOL_DOCS, tool
        assert tool in tools._DISPATCH, tool
        assert tool in toolschema.SCHEMAS, tool
    # 古い名前は、どこにも残っていない（AIに同じ事をする道具を2つ見せない）
    for gone in ("browser_visit", "local_browse", "local_browse_act"):
        assert gone not in tools.TOOL_DOCS and gone not in tools._DISPATCH, gone


def test_public_pages_are_as_light_as_before():
    """誰にもログインしていない所で開く・押すのは、以前の browser_visit と同じ段階0。

    ここを重くすると、公開ページを1枚開くたびに確認が出る（確認は、
    読まずに押す癖を作る）。
    """
    public = {"url": "https://example.com/"}
    assert risk.level("browser_open", public) == 0
    assert risk.level("browser_act", public) == 0


def test_acting_says_why_when_there_is_nowhere_to_run(monkeypatch):
    """手元の台も、サーバーのブラウザも無い。押せないと言い、どうすればよいかも言う。"""
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    import tools
    out = tools.execute_tool("browser_act", {"url": "https://example.com",
                                             "steps": [{"do": "click", "target": "a"}]})
    assert "操作できる場所がありません" in out
    assert "--site" in out and "ENABLE_BROWSER" in out


def test_opening_falls_back_to_plain_text_and_says_so(monkeypatch):
    """読むだけなら、ブラウザが無くても文字は取れる。ただし、そう言う。

    JavaScriptで後から出る中身は入らないので、「全部読んだ」顔をしない。
    """
    monkeypatch.delenv("ENABLE_BROWSER", raising=False)
    import tools
    monkeypatch.setattr(tools, "_do_web_read", lambda p: "本文だけ")
    out = tools.execute_tool("browser_open", {"url": "https://example.com"})
    assert "文字だけ読みました" in out and "本文だけ" in out


def test_empty_url_is_refused():
    import tools
    assert "URLが空" in tools.execute_tool("browser_open", {"url": " "})
    # 押す方は手順が要る（無ければ、引数の形の段階で直し方を返す）
    assert "URLが空" in tools.execute_tool(
        "browser_act", {"url": " ", "steps": [{"do": "click", "target": "a"}]})
    assert "steps" in tools.execute_tool("browser_act", {"url": "https://example.com"})


# ── 本物のブラウザで（入っている置き場でだけ動く） ──────────────────

def _chrome_here() -> bool:
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    return bool(browser._find_chrome())


@pytest.mark.skipif(not _chrome_here(), reason="この環境にはブラウザが無い")
def test_reads_a_page_whose_body_is_written_by_javascript(monkeypatch):
    """ここがこの機能の存在理由。web_read では空に見えるページを読む。"""
    import http.server
    import socketserver
    import threading

    html = (
        "<!doctype html><html><head><title>JSのページ</title></head><body>"
        "<div id=root></div>"
        "<script>document.getElementById('root').textContent="
        "'JSで入れた本文';</script></body></html>"
    ).encode("utf-8")

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("ENABLE_BROWSER", "1")
        # 127.0.0.1 は netguard が弾く（それが正しい）。試すあいだだけ通す。
        import netguard
        monkeypatch.setattr(netguard, "ip_reason", lambda ip: "")
        got = browser.visit(f"http://127.0.0.1:{port}/")
        assert got["ok"] is True, got
        assert "JSで入れた本文" in got["text"]
        assert got["title"] == "JSのページ"
        # 同じページを HTTP だけで読むと、本文は取れない
        import web
        plain = web.web_read(f"http://127.0.0.1:{port}/")
        assert "JSで入れた本文" not in (plain.get("text") or "")
    finally:
        srv.shutdown()
