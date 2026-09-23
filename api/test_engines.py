"""
ブラウザのエンジンを役割で使い分ける所（agent_local/engines.py）を見張る。

    OpenCLI（あなたのChrome）   … AIが見ながら判断して操作する
    Playwright（専用ブラウザ）   … 決まった手順を毎回同じに流す／OpenCLIの代わり

OpenCLI の偽物について
----------------------
本物の OpenCLI は Chrome の拡張と常駐のデーモンが要り、この環境では動かせない。
そこで**本物と同じ返し方をする偽物**を立てる。返し方はソースから写した:

    open            → {"url": ...}                         （src/cli.ts）
    get url / title → 1行の文字
    get text body   → {"value": ..., "matches_n": 1}
    click           → {"clicked": true, "target": ...}
    fill            → {"filled": true, "verified": true, ...}
    state           → "URL: ...\\n\\n  [1]<button>送信</button>"
    繋がらない      → 終了コード 69（src/errors.ts SERVICE_UNAVAIL）

偽物は受け取った引数と環境変数を全部書き出すので、「何を渡したか」を
後から確かめられる。**ここで見たいのは、こちらが OpenCLI に何を渡すか**
——渡してはいけない物を渡していないか——なので、偽物で足りる。
"""

import json
import os
import stat
import sys
import textwrap

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent_local"))

import aibou_local  # noqa: E402
import engines      # noqa: E402

FAKE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    here = os.path.dirname(os.path.abspath(__file__))
    log = os.path.join(here, "calls.jsonl")
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "env": sorted(os.environ)}) + "\\n")
    if os.path.exists(os.path.join(here, "DOWN")):
        print("Browser Bridge not connected", file=sys.stderr)
        sys.exit(69)
    state = os.path.join(here, "url.txt")
    url = open(state).read() if os.path.exists(state) else "about:blank"
    a = sys.argv[1:]
    assert a[0] == "browser" and a[1] == "aibou", a
    cmd, rest = a[2], a[3:]
    if cmd == "open":
        open(state, "w").write(rest[0]); print(json.dumps({"url": rest[0]}))
    elif cmd == "get" and rest[0] == "url":
        print(url)
    elif cmd == "get" and rest[0] == "title":
        print("社内ダッシュボード")
    elif cmd == "get" and rest[0] == "text":
        print(json.dumps({"value": "今月の売上 123万円\\n対応が必要なケース 4件", "matches_n": 1}))
    elif cmd == "state":
        print("URL: " + url + "\\n\\n  [1]<button id=a>送信</button>\\n  [2]<a href=/x>次へ</a>")
    elif cmd == "click":
        name = rest[rest.index("--name") + 1]
        if name == "外へ":
            open(state, "w").write("https://evil.example/steal")
        print(json.dumps({"clicked": True, "target": name, "matches_n": 1}))
    elif cmd == "fill":
        print(json.dumps({"filled": True, "verified": True, "text": rest[-1]}))
    elif cmd in ("keys", "wait", "close", "select"):
        print(json.dumps({"ok": True}))
    else:
        print(json.dumps({"error": {"code": "unknown", "message": cmd}})); sys.exit(2)
''')


@pytest.fixture
def fake_opencli(tmp_path):
    """本物と同じ返し方をする opencli。呼ばれた中身は calls.jsonl に残る。"""
    path = tmp_path / "opencli"
    path.write_text(FAKE, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)

    class Fake:
        dir = tmp_path
        binary = str(path)

        def calls(self):
            log = tmp_path / "calls.jsonl"
            if not log.exists():
                return []
            return [json.loads(l) for l in log.read_text().splitlines() if l]

        def argvs(self):
            return [c["argv"] for c in self.calls()]

        def down(self):
            (tmp_path / "DOWN").write_text("1")

    return Fake()


class FakePlaywright(engines.BrowserEngine):
    """Chrome を立ち上げずに「専用ブラウザで開いた」ことにする代わり。"""
    name = "playwright"
    label = "専用ブラウザ（Playwright）"

    def __init__(self):
        self.opened = []
        self.url = ""

    def open(self, url):
        self.opened.append(url)
        self.url = url

    def current_url(self):
        return self.url

    def step(self, kind, target, value):
        return f"{kind}:{target}"

    def read(self):
        return {"title": "専用ブラウザの画面", "url": self.url, "text": "中身", "links": []}


def _runner(tmp_path, fake, engine="auto", sites=("intra.example.co.jp",)):
    guard = aibou_local.Guard([str(tmp_path)], sites=list(sites))
    r = aibou_local.Runner(guard, False, False, lambda *_: None,
                           allow_browser=True, profile=str(tmp_path / "p"),
                           headless=True, engine=engine,
                           opencli=engines.OpenCLIEngine(binary=fake.binary))
    r.playwright = FakePlaywright()
    return r


URL = "https://intra.example.co.jp/cases"


# ── 役割: AIが判断して動かすときは、あなたのChrome（OpenCLI） ─────────

def test_ai_judged_work_goes_to_your_chrome_when_available(tmp_path, fake_opencli):
    r = _runner(tmp_path, fake_opencli)
    got = r.do({"kind": "browse", "params": {"url": URL}})
    assert got["ok"] is True, got
    assert got["engine"] == "opencli"
    assert "対応が必要なケース 4件" in got["text"]
    assert r.playwright.opened == []           # 専用ブラウザは使っていない


def test_it_is_reported_which_browser_did_the_work(tmp_path, fake_opencli):
    """あなたのChromeか専用ブラウザかで、ログインしているかが変わる。"""
    got = _runner(tmp_path, fake_opencli).do({"kind": "browse", "params": {"url": URL}})
    assert got["engine_label"] == "あなたのChrome（OpenCLI）"


def test_clicking_maps_to_opencli_by_accessible_name(tmp_path, fake_opencli):
    r = _runner(tmp_path, fake_opencli)
    r.do({"kind": "browse_act", "params": {"url": URL, "steps": [
        {"do": "fill", "target": "検索", "value": "至急"},
        {"do": "click", "target": "送信"},
    ]}})
    argvs = fake_opencli.argvs()
    assert ["browser", "aibou", "fill", "--label", "検索", "至急"] in argvs
    assert ["browser", "aibou", "click", "--name", "送信"] in argvs


def test_the_page_text_and_buttons_come_back(tmp_path, fake_opencli):
    got = _runner(tmp_path, fake_opencli).do({"kind": "browse", "params": {"url": URL}})
    assert got["title"] == "社内ダッシュボード"
    assert [l["label"] for l in got["links"]] == ["送信", "次へ"]


# ── OpenCLI が使えないとき ────────────────────────────────────────────

def test_when_opencli_is_not_connected_it_falls_back_and_says_so(tmp_path, fake_opencli):
    """黙って止まらない。そして、替えたことを黙らない。

    専用ブラウザはログイン状態が違う（あなたのChromeではない）ので、
    替えたことを言わないと、結果の読み方を間違える。
    """
    fake_opencli.down()
    r = _runner(tmp_path, fake_opencli)
    got = r.do({"kind": "browse", "params": {"url": URL}})
    assert got["ok"] is True
    assert got["engine"] == "playwright"
    assert r.playwright.opened == [URL]
    assert "Chromeに繋がっていません" in got["note"]
    assert "専用ブラウザで開きました" in got["note"]


def test_when_opencli_is_named_it_does_not_silently_switch(tmp_path, fake_opencli):
    """`--browser-engine opencli` と名指ししたなら、黙って替えない。"""
    fake_opencli.down()
    r = _runner(tmp_path, fake_opencli, engine="opencli")
    got = r.do({"kind": "browse", "params": {"url": URL}})
    assert got["ok"] is False
    assert "繋がっていません" in got["error"]
    assert r.playwright.opened == []


def test_when_opencli_is_not_installed_the_dedicated_browser_is_used(tmp_path):
    guard = aibou_local.Guard([str(tmp_path)], sites=["intra.example.co.jp"])
    r = aibou_local.Runner(guard, False, False, lambda *_: None, allow_browser=True,
                           profile=str(tmp_path / "p"), headless=True,
                           opencli=engines.OpenCLIEngine(binary=str(tmp_path / "無い")))
    r.playwright = FakePlaywright()
    got = r.do({"kind": "browse", "params": {"url": URL}})
    assert got["ok"] is True and got["engine"] == "playwright"


def test_playwright_can_be_chosen_explicitly(tmp_path, fake_opencli):
    r = _runner(tmp_path, fake_opencli, engine="playwright")
    got = r.do({"kind": "browse", "params": {"url": URL}})
    assert got["engine"] == "playwright"
    assert fake_opencli.calls() == []


# ── 許可リストは、エンジンの手前で必ず通す ────────────────────────────

def test_a_site_outside_the_list_never_reaches_opencli(tmp_path, fake_opencli):
    """OpenCLI の拡張は <all_urls> を持つ。「このサイトだけ」はこちらが守る。"""
    got = _runner(tmp_path, fake_opencli).do(
        {"kind": "browse", "params": {"url": "https://bank.example.com/"}})
    assert got["ok"] is False and "許したサイトの外" in got["error"]
    assert fake_opencli.calls() == []


def test_leaving_the_allowed_sites_stops_everything(tmp_path, fake_opencli):
    """押したボタンの先が別のサイトだったら、そこで止める。

    OpenCLI では先回りできない（拡張がどこへでも届くので）。だから
    **動いたあとに**いまどこかを見て、外なら、続きの手順も読み取りも
    やらない。
    """
    r = _runner(tmp_path, fake_opencli)
    got = r.do({"kind": "browse_act", "params": {"url": URL, "steps": [
        {"do": "click", "target": "外へ"},
        {"do": "fill", "target": "パスワード", "value": "x"},
    ]}})
    assert got["ok"] is False
    assert "evil.example" in got["error"] and "止めました" in got["error"]
    argvs = fake_opencli.argvs()
    # 外へ出たあとは、入力も読み取りもしていない
    assert not any(a[2] == "fill" for a in argvs)
    assert not any(a[2:4] == ["get", "text"] for a in argvs)


def test_a_goto_in_the_middle_is_also_checked(tmp_path, fake_opencli):
    r = _runner(tmp_path, fake_opencli)
    got = r.do({"kind": "browse_act", "params": {"url": URL, "steps": [
        {"do": "goto", "value": "https://evil.example/"},
    ]}})
    assert any("断りました" in d for d in got["did"])
    assert not any(a[2] == "open" and "evil" in a[3] for a in fake_opencli.argvs())


# ── OpenCLI に渡さない物 ──────────────────────────────────────────────

@pytest.mark.parametrize("cmd", [
    ["eval", "document.cookie"],          # 任意のJS
    ["upload", "--label", "添付", "/etc/passwd"],   # 手元のファイルを持ち出せる
    ["bind"],                             # いま人が見ているタブを乗っ取る
    ["network"],                          # 通信の中身（認証の見出しを含む）
    ["screenshot", "/tmp/x.png"],
    ["init", "a/b"],
    ["get", "html"],
    ["get", "attributes"],
])
def test_dangerous_opencli_commands_are_never_built(fake_opencli, cmd):
    e = engines.OpenCLIEngine(binary=fake_opencli.binary)
    with pytest.raises(PermissionError):
        e._run(cmd)
    assert fake_opencli.calls() == []


def test_a_step_with_an_unknown_verb_is_not_passed_through(tmp_path, fake_opencli):
    r = _runner(tmp_path, fake_opencli)
    got = r.do({"kind": "browse_act", "params": {"url": URL, "steps": [
        {"do": "eval", "target": "document.cookie"},
        {"do": "bind"},
    ]}})
    assert got["ok"] is True
    assert all(a[2] not in ("eval", "bind") for a in fake_opencli.argvs())


def test_no_shell_and_always_the_same_binary(fake_opencli, monkeypatch):
    seen = {}

    def spy(argv, **kw):
        seen.update(argv=argv, **kw)

        class R:
            returncode = 0
            stdout = '{"url": "https://intra.example.co.jp/"}'
        return R()

    e = engines.OpenCLIEngine(binary=fake_opencli.binary, runner=spy)
    e.open("https://intra.example.co.jp/")
    assert seen["shell"] is False
    assert seen["argv"][:3] == [fake_opencli.binary, "browser", "aibou"]
    assert isinstance(seen["argv"], list)       # 1本の文字列にしない


def test_keys_and_tokens_are_not_handed_to_opencli(tmp_path, fake_opencli, monkeypatch):
    """子のプロセスへ、APIの鍵やトークンを渡さない。"""
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "x")
    monkeypatch.setenv("AIBOU_TOKEN", "x")
    monkeypatch.setenv("OPENCLI_PROFILE", "work")          # OpenCLI 自身の設定は渡す
    monkeypatch.setenv("OPENCLI_API_TOKEN", "x")            # ただし鍵らしい名前は渡さない
    _runner(tmp_path, fake_opencli).do({"kind": "browse", "params": {"url": URL}})
    env = fake_opencli.calls()[0]["env"]
    for bad in ("GEMINI_API_KEY", "SUPABASE_SERVICE_KEY", "AIBOU_TOKEN", "OPENCLI_API_TOKEN"):
        assert bad not in env, bad
    assert "OPENCLI_PROFILE" in env
    assert "PATH" in env


# ── 形の読み取り ──────────────────────────────────────────────────────

def test_state_lines_are_read_in_the_real_format():
    snap = ("URL: https://x\n\n"
            "  [1]<button type=submit>送信</button>\n"
            "    [12]<a href=/cases/9>ケース 9</a>\n"
            "  <div>ただの文字</div>\n"
            "  [3]<svg />\n")
    got = engines.parse_state_links(snap)
    assert [(g["ref"], g["label"]) for g in got] == [(1, "送信"), (12, "ケース 9")]


def test_an_unreadable_state_gives_nothing_rather_than_crashing():
    assert engines.parse_state_links("") == []
    assert engines.parse_state_links("まったく別の形") == []


# ── サーバーから見えること ────────────────────────────────────────────

def test_the_machine_tells_the_server_which_browsers_it_has(tmp_path, fake_opencli):
    r = _runner(tmp_path, fake_opencli)
    assert r.engines()[0] == "opencli"


def test_nothing_is_reported_when_browsing_is_off(tmp_path, fake_opencli):
    guard = aibou_local.Guard([str(tmp_path)], sites=["intra.example.co.jp"])
    r = aibou_local.Runner(guard, False, False, lambda *_: None, allow_browser=False,
                           opencli=engines.OpenCLIEngine(binary=fake_opencli.binary))
    assert r.engines() == []


def test_the_server_remembers_and_shows_the_engines():
    import localagent
    localagent.reset()
    try:
        got = localagent.pair("u1", "ノート")
        localagent.take("u1", got["device"], wait=0.01)
        localagent.note_engines("u1", got["device"], ["opencli", "playwright", "謎"])
        dev = localagent.status("u1")["devices"][0]
        assert dev["engines"] == ["opencli", "playwright"]     # 知らない名前は捨てる
    finally:
        localagent.reset()


def test_the_endpoint_records_the_header():
    import localagent
    import main
    from fastapi.testclient import TestClient
    localagent.reset()
    try:
        client = TestClient(main.app)
        token = client.post("/local/pair", json={"name": "ノート"}).json()["token"]
        client.get("/local/jobs", params={"wait": 0},
                   headers={"X-Local-Token": token, "X-Local-Engines": "opencli,playwright"})
        dev = localagent.status("local")["devices"][0]
        assert dev["engines"] == ["opencli", "playwright"]
    finally:
        localagent.reset()


# ── 専用ブラウザ（本物のChromiumで） ──────────────────────────────────

def _chrome_here() -> bool:
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    return bool(aibou_local.find_chrome())


@pytest.mark.skipif(not _chrome_here(), reason="この環境にはブラウザが無い")
def test_playwright_blocks_leaving_the_list_before_loading(tmp_path):
    """専用ブラウザでは、許可の外への移動を**読み込む前に**止められる。

    127.0.0.1 だけを許し、ページには localhost（＝別のホスト名）への
    リンクを置く。押すと、外のページは読み込まれず、止めた先の名前で
    止まった理由が返る。

    書き始めは「押しても画面は元のまま」を期待していた。本物の Chromium で
    走らせると、止めたあとに Chrome が自前のエラー画面
    （chrome-error://chromewebdata/）を出し、利用者には「chromewebdata へ
    移った」という意味の無い文が出ていた。止めた先を覚えておいて、そちらを
    言うように直した。
    """
    import http.server
    import socketserver
    import threading

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            port = self.server.server_address[1]
            if self.path == "/":
                body = (f"<a href='http://localhost:{port}/secret'>外へ</a>"
                        "<p>はじめのページ</p>").encode()
            else:
                body = "<p>外のページ</p>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    guard = aibou_local.Guard([str(tmp_path)], sites=["127.0.0.1"])
    r = aibou_local.Runner(guard, False, False, lambda *_: None, allow_browser=True,
                           profile=str(tmp_path / "p"), headless=True,
                           engine="playwright")
    try:
        got = r.do({"kind": "browse_act", "params": {
            "url": f"http://127.0.0.1:{port}/",
            "steps": [{"do": "click", "target": "外へ"}]}})
        assert got["ok"] is False, got
        # 止めた先の名前で言う（chromewebdata ではなく）
        assert "localhost" in got["error"]
        assert "読み込む前に止めました" in got["error"]
        assert "chromewebdata" not in got["error"]
        # 外のページの中身は、どこにも返っていない
        assert "外のページ" not in json.dumps(got, ensure_ascii=False)
    finally:
        r.close_browser()
        srv.shutdown()
