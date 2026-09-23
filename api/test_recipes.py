"""
決まった手順（recipes.py）を見張る。

ここで守りたいこと
------------------
1. **パスワードを手順に入れない。** 手順はクラウド（あなたのDB）に残る。
   ログインは本人が手元で一度だけ通す
2. 空け所（`{顧客名}`）に入れる値が、URLの別の引数に化けない
3. 名前の揺れは許すが、2つ当たるときは決めない（違う手順を流さない）
4. 保存先が無いときに「保存しました」とだけ言わない
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import recipes


@pytest.fixture(autouse=True)
def clean():
    recipes._mem._by_tenant.clear()
    yield
    recipes._mem._by_tenant.clear()


CASES = [
    {"do": "fill", "target": "検索", "value": "{顧客名}"},
    {"do": "click", "target": "検索する"},
    {"do": "wait", "value": "1000"},
]


def _save(name="朝のケース確認", url="https://intra.example.co.jp/cases", steps=None, **kw):
    return recipes.save(name, url, CASES if steps is None else steps, **kw)


# ── 保存 ────────────────────────────────────────────────────────────

def test_saves_with_its_blanks():
    got = _save(description="担当で絞って一覧を読む")
    assert got["ok"] is True
    r = got["recipe"]
    assert r["params"] == ["顧客名"]
    assert len(r["steps"]) == 3
    assert recipes.get("朝のケース確認")["id"] == r["id"]


def test_same_name_replaces_instead_of_piling_up():
    first = _save()["recipe"]
    again = _save(steps=[{"do": "click", "target": "更新"}])
    assert again["replaced"] is True
    assert again["recipe"]["id"] == first["id"]
    assert len(recipes.list_all()) == 1


@pytest.mark.parametrize("label", [
    "パスワード", "Password", "暗証番号", "PIN", "PINコード", "ワンタイムパスワード",
    "認証コード", "セキュリティコード", "カード番号", "CVV", "API token",
])
def test_password_fields_are_never_saved(label):
    """値が空け所でも断る。欄そのものに打ち込む手順を作らない。"""
    got = _save(steps=[{"do": "fill", "target": label, "value": "{pw}"}])
    assert got["ok"] is False
    assert recipes.list_all() == []


@pytest.mark.parametrize("label", ["検索", "顧客名", "Pinterest", "spinner", "担当者"])
def test_ordinary_fields_are_fine(label):
    assert _save(steps=[{"do": "fill", "target": label, "value": "x"}])["ok"] is True


def test_key_like_values_are_refused():
    got = _save(steps=[{"do": "fill", "target": "メモ",
                        "value": "AIzaSyA-1234567890abcdefghijklmnopqrstu"}])
    assert got["ok"] is False and "キー" in got["error"]


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "javascript:alert(1)", "", "intra.example.co.jp",
    "https://{会社}.example.com/", "https://user:pw@example.com/",
])
def test_the_start_page_must_be_a_plain_web_page(url):
    assert _save(url=url)["ok"] is False


def test_unknown_moves_are_refused():
    for bad in ("evaluate", "upload", "download", ""):
        got = _save(steps=[{"do": bad, "target": "x"}])
        assert got["ok"] is False, bad


def test_steps_are_capped():
    many = [{"do": "click", "target": f"b{i}"} for i in range(recipes.MAX_STEPS + 1)]
    assert _save(steps=many)["ok"] is False


def test_a_name_is_required():
    assert _save(name="  ")["ok"] is False


def test_it_says_when_it_is_not_really_kept():
    """保存先が無ければメモリに置くしかない。そう言えるように、置き場を返す。"""
    assert _save()["stored"] == "memory"


# ── 引く ────────────────────────────────────────────────────────────

def test_names_can_be_said_loosely_but_not_ambiguously():
    _save(name="朝のケース確認")
    _save(name="夕方の日報")
    assert recipes.get("朝のケース確認を流して")["name"] == "朝のケース確認"
    assert recipes.get("夕方の日報")["name"] == "夕方の日報"
    _save(name="朝のケース確認（東京）")
    # 2つ当たる言い方では決めない
    assert recipes.get("朝のケース") is None


# ── 流す形にする ────────────────────────────────────────────────────

def test_blanks_must_be_filled():
    r = _save()["recipe"]
    got = recipes.materialize(r, {})
    assert got["ok"] is False and got["missing"] == ["顧客名"]


def test_values_in_the_url_cannot_become_other_arguments():
    r = _save(url="https://intra.example.co.jp/search?q={顧客名}&view=mine")["recipe"]
    got = recipes.materialize(r, {"顧客名": "山田&view=all"})
    assert got["ok"] is True
    assert got["url"] == ("https://intra.example.co.jp/search?q="
                          "%E5%B1%B1%E7%94%B0%26view%3Dall&view=mine")


def test_values_typed_into_fields_stay_as_written():
    r = _save()["recipe"]
    got = recipes.materialize(r, {"顧客名": "山田 & 佐藤"})
    assert got["steps"][0]["value"] == "山田 & 佐藤"


def test_key_like_values_are_not_typed_in():
    r = _save()["recipe"]
    got = recipes.materialize(r, {"顧客名": "sk-abcdefghijklmnopqrstuvwxyz123456"})
    assert got["ok"] is False


def test_reading_only_recipes_are_told_apart():
    looking = _save(name="見るだけ", steps=[{"do": "wait", "value": "500"}])["recipe"]
    touching = _save()["recipe"]
    assert recipes.touches(looking) is False
    assert recipes.touches(touching) is True


def test_the_last_run_is_kept():
    r = _save()["recipe"]
    recipes.mark_run(r["id"], False, "2手目で止まりました")
    assert recipes.get(r["id"])["last_result"].startswith("✗")


def test_delete():
    _save()
    assert recipes.delete("朝のケース確認")["ok"] is True
    assert recipes.list_all() == []
    assert recipes.delete("朝のケース確認")["ok"] is False


# ── サーバーのブラウザで流すときも、失敗したら止める ──────────────────

def _chrome_here() -> bool:
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    import browser
    return bool(browser._find_chrome())


@pytest.mark.skipif(not _chrome_here(), reason="この環境にはブラウザが無い")
def test_a_failed_step_stops_the_rest(monkeypatch):
    """2手目が押せなければ、3手目（送信）は押さない。

    AIが見ながら進めるとき（browser_act）は、できなかった手を書いて先へ進む。
    決まった手順は、途中がずれたまま押し進めると違う物を送りうるので止める。
    """
    import http.server
    import socketserver
    import threading

    sent = []
    html = ("<!doctype html><html><head><title>フォーム</title></head><body>"
            "<label for=q>検索</label><input id=q name=q>"
            "<a href='/sent'>送信する</a></body></html>").encode("utf-8")

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/sent"):
                sent.append(self.path)
            body = html if not self.path.startswith("/sent") else "<p>送りました</p>".encode()
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
    try:
        monkeypatch.setenv("ENABLE_BROWSER", "1")
        import browser
        import netguard
        monkeypatch.setattr(netguard, "ip_reason", lambda ip: "")
        steps = [{"do": "fill", "target": "検索", "value": "東京"},
                 {"do": "click", "target": "ありもしないボタン"},
                 {"do": "click", "target": "送信する"}]
        got = browser.visit(f"http://127.0.0.1:{port}/", steps, strict=True)
        assert got["ok"] is False and got["stopped_at"] == 2, got
        assert len(got["did"]) == 2
        assert sent == [], "止めたはずの3手目（送信）が押された"

        # 止めない形（AIが見ながら進めるとき）は、最後まで進む
        loose = browser.visit(f"http://127.0.0.1:{port}/", steps)
        assert len(loose["did"]) == 3
        assert sent, "止めない形なのに3手目まで進んでいない"
    finally:
        srv.shutdown()
