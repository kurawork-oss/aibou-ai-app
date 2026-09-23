"""
手元の相棒が、保存した手順を流す所（agent_local/aibou_local.py の _recipe）。

AIが見ながら進める browse_act との違いを見張る:

  ・エンジンは専用ブラウザ（Playwright）に決め打ち。OpenCLI が使えても使わない
  ・1手でも失敗したら、そこで止める。続きは押さない
  ・パスワードの欄には打ち込まない（名前でも、欄の種類でも見る）
  ・許可リスト（--site）の外へは、途中でも出ない
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent_local"))

import aibou_local  # noqa: E402
import engines      # noqa: E402

SITE = "intra.example.co.jp"
URL = f"https://{SITE}/cases"


class Scripted(engines.BrowserEngine):
    """押した手を記録する専用ブラウザの代わり。`fail_on` の手で失敗する。"""
    name = "playwright"
    label = "専用ブラウザ（Playwright）"

    def __init__(self, fail_on=None, jump_to=None):
        self.url = ""
        self.pressed = []
        self.fail_on = fail_on or set()
        self.jump_to = jump_to or {}

    def open(self, url):
        self.url = url

    def current_url(self):
        return self.url

    def try_step(self, kind, target, value):
        self.pressed.append((kind, target))
        if target in self.fail_on:
            return False, f"「{target}」が見つかりませんでした"
        if target in self.jump_to:
            self.url = self.jump_to[target]
        return True, f"{kind}:{target}"

    def read(self):
        return {"title": "一覧", "url": self.url, "text": "3件", "links": []}


class NeverOpenCLI(engines.OpenCLIEngine):
    """「使える」と言うが、呼ばれたら落ちる OpenCLI。手順で呼ばれないことを見る。"""

    def why_unavailable(self):
        return ""

    def open(self, url):
        raise AssertionError("手順が OpenCLI（あなたのChrome）で流れた")

    def try_step(self, kind, target, value):
        raise AssertionError("手順が OpenCLI（あなたのChrome）で流れた")


def _runner(tmp_path, pw, sites=(SITE,)):
    guard = aibou_local.Guard([str(tmp_path)], sites=list(sites))
    r = aibou_local.Runner(guard, False, False, lambda *_: None, allow_browser=True,
                           profile=str(tmp_path / "p"), headless=True,
                           opencli=NeverOpenCLI())
    r.playwright = pw
    return r


def _run(r, steps, url=URL):
    return r.do({"kind": "recipe", "params": {"name": "朝のケース確認", "url": url,
                                              "steps": steps}})


def test_recipes_always_use_the_dedicated_browser(tmp_path):
    pw = Scripted()
    got = _run(_runner(tmp_path, pw), [{"do": "click", "target": "検索する"}])
    assert got["ok"] is True, got
    assert got["engine"] == "playwright"
    assert pw.pressed == [("click", "検索する")]


def test_a_failed_step_stops_the_rest(tmp_path):
    pw = Scripted(fail_on={"絞り込み"})
    got = _run(_runner(tmp_path, pw), [
        {"do": "fill", "target": "検索", "value": "山田"},
        {"do": "click", "target": "絞り込み"},
        {"do": "click", "target": "送信"},
    ])
    assert got["ok"] is False and got["stopped_at"] == 2
    assert "続きは押していません" in got["error"]
    assert ("click", "送信") not in pw.pressed, "止めたはずの3手目が押された"


def test_password_fields_are_not_typed_into(tmp_path):
    pw = Scripted()
    got = _run(_runner(tmp_path, pw), [{"do": "fill", "target": "パスワード",
                                        "value": "hunter2"}])
    assert got["ok"] is False and got["stopped_at"] == 1
    assert pw.pressed == [], "パスワード欄に打ち込もうとした"


def test_ai_judged_steps_skip_password_fields_too(tmp_path):
    """AIが見ながら進めるとき（browse_act）も、パスワード欄には打ち込まない。"""
    pw = Scripted()
    r = _runner(tmp_path, pw)
    r.engine_pref = "playwright"
    got = r.do({"kind": "browse_act", "params": {"url": URL, "steps": [
        {"do": "fill", "target": "Password", "value": "hunter2"},
        {"do": "click", "target": "ログイン"}]}})
    assert got["ok"] is True
    assert ("fill", "Password") not in pw.pressed
    assert any("入力しません" in line for line in got["did"])


def test_a_move_outside_the_allowed_sites_stops(tmp_path):
    pw = Scripted(jump_to={"外へ": "https://evil.example/steal"})
    got = _run(_runner(tmp_path, pw), [{"do": "click", "target": "外へ"},
                                       {"do": "click", "target": "送信"}])
    assert got["ok"] is False and got["stopped_at"] == 1
    assert "evil.example" in got["error"]
    assert ("click", "送信") not in pw.pressed


def test_goto_is_checked_against_the_allowed_sites(tmp_path):
    pw = Scripted()
    got = _run(_runner(tmp_path, pw), [{"do": "goto", "value": "https://evil.example/"}])
    assert got["ok"] is False and got["stopped_at"] == 1
    assert pw.pressed == []


def test_the_start_page_must_be_allowed(tmp_path):
    got = _run(_runner(tmp_path, Scripted()), [], url="https://evil.example/")
    assert got["ok"] is False


def test_recipes_need_the_browser_switched_on(tmp_path):
    guard = aibou_local.Guard([str(tmp_path)], sites=[SITE])
    r = aibou_local.Runner(guard, False, False, lambda *_: None, allow_browser=False)
    got = _run(r, [{"do": "click", "target": "x"}])
    assert got["ok"] is False and "--allow-browser" in got["error"]


def test_the_agent_tells_the_server_what_it_can_do(tmp_path, monkeypatch):
    """古い相棒と見分けるため、引き受けられる仕事を毎回知らせる。"""
    seen = {}

    class Session:
        def get(self, url, params=None, headers=None, timeout=None):
            seen.update(headers or {})

            class R:
                status_code = 200

                def raise_for_status(self):
                    pass

                def json(self):
                    return {"job": None}
            return R()

    monkeypatch.setattr(aibou_local.requests, "Session", Session)
    r = _runner(tmp_path, Scripted())
    aibou_local.loop("https://api.example", "tok", r, lambda *_: None, once=True)
    assert "recipe" in seen["X-Local-Jobs"].split(",")


# ── 本物のブラウザで ────────────────────────────────────────────────

def _chrome_here() -> bool:
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    return bool(aibou_local.find_chrome())


@pytest.mark.skipif(not _chrome_here(), reason="この環境にはブラウザが無い")
def test_a_real_recipe_runs_and_a_real_password_box_is_refused(tmp_path):
    """名前が普通の欄でも、欄そのものがパスワード用なら打ち込まない。"""
    import http.server
    import socketserver
    import threading

    html = ("<!doctype html><html><head><title>フォーム</title></head><body>"
            "<label for=q>検索</label><input id=q>"
            "<label for=k>合言葉</label><input id=k type=password>"
            "<button onclick=\"document.body.innerHTML+='<p>探しました: '"
            "+document.getElementById('q').value+'</p>'\">検索する</button>"
            "</body></html>").encode("utf-8")

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
    guard = aibou_local.Guard([str(tmp_path)], sites=["127.0.0.1"])
    runner = aibou_local.Runner(guard, False, False, lambda *_: None, allow_browser=True,
                                profile=str(tmp_path / "prof"), headless=True)
    try:
        url = f"http://127.0.0.1:{port}/"
        ok = runner.do({"kind": "recipe", "params": {"url": url, "steps": [
            {"do": "fill", "target": "検索", "value": "山田商事"},
            {"do": "click", "target": "検索する"}]}})
        assert ok["ok"] is True, ok
        assert "探しました: 山田商事" in ok["text"]

        # 「合言葉」は名前だけでは鍵の欄と分からない。欄の種類で断る
        refused = runner.do({"kind": "recipe", "params": {"url": url, "steps": [
            {"do": "fill", "target": "合言葉", "value": "hunter2"},
            {"do": "click", "target": "検索する"}]}})
        assert refused["ok"] is False and refused["stopped_at"] == 1, refused
        assert "入力しません" in refused["error"]
    finally:
        runner.close_browser()
        srv.shutdown()
