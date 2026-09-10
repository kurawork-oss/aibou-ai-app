# test_guardrails.py — 守ると決めた線が、まだ守られているか
#
# 個々の機能のテストは、その機能が壊れたら落ちる。けれど「秘密が漏れない」
# 「勝手に実行しない」のような線は、**関係ない工事の巻き添えで**静かに
# 崩れる。だから機能ごとではなく、線ごとにまとめて見張る。
#
# ここが1本でも落ちたら、機能が動いていても出してはいけない。
#
# 文字列を探すのではなく、**動かして**確かめる。「その名前がソースに出て
# くる」では、消し忘れた変数を数えているのと変わらない。

import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
import keychain
import risk
import shellrun
import tools


# ── ① 秘密は外に出さない ────────────────────────────────────────────
def test_the_key_list_never_carries_the_real_value():
    """画面に出るのはマスクだけ。ここが崩れると、画面を見せた相手に鍵が渡る。"""
    keychain.set_key("GEMINI_API_KEY", "sk-very-secret-value-123")
    try:
        shown = str(keychain.list_keys())
        assert "sk-very-secret-value-123" not in shown
        assert "masked" in shown
    finally:
        keychain.delete_key("GEMINI_API_KEY")


def test_child_processes_get_an_allow_list_not_a_deny_list(monkeypatch):
    """子プロセスに渡す環境変数は「許可した物だけ」。

    禁止リストにすると、秘密が1つ増えるたびに足し忘れが起きる。
    許可制なら、新しい秘密が増えても自動的に漏れない。
    """
    for k in ("GEMINI_API_KEY", "SUPABASE_SERVICE_KEY", "KEYCHAIN_SECRET",
              "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"):
        monkeypatch.setenv(k, f"secret-{k}")

    env = shellrun._clean_env()
    leaked = [k for k, v in env.items() if "secret-" in str(v)]
    assert leaked == [], f"子プロセスに渡っている: {leaked}"
    assert set(env) <= {
        "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR",
        "PYTHONDONTWRITEBYTECODE", "NO_COLOR", "CI",
    }, f"許可していない物が混ざっている: {sorted(env)}"


# ── ② 勝手に実行しない ──────────────────────────────────────────────
def test_every_dispatchable_tool_has_a_risk_level():
    """危なさが決まっていない道具は、確認なしで走ってしまう。"""
    missing = [t for t in tools._DISPATCH if t not in risk.LEVELS]
    assert missing == [], f"危なさ未設定: {missing}"


def test_irreversible_work_always_asks_even_with_approval_off():
    """送ったメールは取り消せない。設定でどうにかできてはいけない。"""
    for tool, lv in risk.LEVELS.items():
        if lv >= 3:
            assert risk.needs_confirmation(tool, False), f"{tool} が黙って走る"


def test_an_unknown_tool_is_treated_as_the_most_dangerous():
    """道具を足して危なさを書き忘れても、確認side に倒れること。"""
    assert risk.UNKNOWN == 3
    assert risk.needs_confirmation("まだ知らない道具", False)


# ── ③ 他人の保存先に書かない ────────────────────────────────────────
def test_an_unconnected_user_is_never_handed_a_database():
    """ここが崩れると、繋いでいない人のデータが共有DBへ入る。"""
    token = config.bind_request_client(None)
    try:
        assert config.get_supabase() is None
    finally:
        config.reset_request_client(token)


# ── ④ プレビューの箱に穴を開けない ──────────────────────────────────
def test_previews_never_combine_scripts_with_same_origin():
    """allow-scripts と allow-same-origin が揃うと、箱の意味が無くなる。

    生成したHTMLを動かす画面があるので、ここは実装ではなく
    「そう書かれていないこと」で守る（1か所でも揃えば穴になる）。
    """
    web = pathlib.Path(__file__).resolve().parent.parent / "webapp" / "src"
    bad = []
    for p in web.rglob("*.tsx"):
        for m in re.finditer(r'sandbox="([^"]*)"', p.read_text(encoding="utf-8")):
            v = m.group(1)
            if "allow-scripts" in v and "allow-same-origin" in v:
                bad.append(f"{p.name}: {v}")
    assert bad == [], f"箱に穴が開いている: {bad}"


# ── ⑤ 連携の戻りで、人を取り違えない ────────────────────────────────
@pytest.fixture
def signed(monkeypatch):
    """署名できる構成にする（人に配るときは必ずこちら）。"""
    monkeypatch.setattr(config, "KEYCHAIN_SECRET", "x" * 32, raising=False)
    import importlib

    import oauth
    importlib.reload(oauth)
    yield oauth
    importlib.reload(oauth)


def test_a_valid_state_identifies_the_person_who_started_it(signed):
    s = signed.sign_state("user-A", "google", owner=True)
    got = signed.verify_state(s, "google")
    assert got.get("ok") and got.get("user_id") == "user-A"
    # 持ち主かどうかも運ぶ（戻りには本人確認が付かないため）
    assert got.get("owner") is True


def test_a_tampered_state_is_refused(signed):
    """細工したURLを踏ませて、他人のAIbouに自分のアカウントを繋がせない。"""
    s = signed.sign_state("user-A", "google")
    flipped = s[:-1] + ("0" if s[-1] != "0" else "1")
    assert "error" in signed.verify_state(flipped, "google")
    # 署名を丸ごと外した物も通さない
    assert "error" in signed.verify_state(s.split(".")[0], "google")
    assert "error" in signed.verify_state("", "google")


def test_a_state_cannot_be_reused_for_another_provider(signed):
    s = signed.sign_state("user-A", "google")
    assert "error" in signed.verify_state(s, "slack")


def test_an_old_state_expires(signed):
    """踏ませたURLが、後から効いてしまわないように。"""
    body = signed.sign_state("user-A", "google").split(".")[0]
    data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    data["t"] = int(time.time()) - signed.STATE_TTL - 60
    nb = base64.urlsafe_b64encode(
        json.dumps(data, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(("x" * 32).encode(), nb.encode(), hashlib.sha256).hexdigest()[:32]
    assert "error" in signed.verify_state(f"{nb}.{sig}", "google")


# ── ⑥ 自己診断が、秘密を出さずに残りの手順を教える ──────────────────
def test_diagnose_shows_what_is_left_without_leaking_it(monkeypatch):
    """「あと何をすればいいか」を、値を出さずに数えられること。

    残りの設定はサーバーの環境変数を見ないと分からず、利用者からは
    「押しても繋がらない」としか見えなかった。ここに出す。
    ただし値そのものは絶対に出さない（診断は認証なしで読めるため）。
    """
    from fastapi.testclient import TestClient

    from main import app

    client = TestClient(app)

    # まだ登録していないうちは、何を入れればいいかを名前で出す
    for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"):
        monkeypatch.delenv(k, raising=False)
    body = client.get("/diagnose").text
    assert "押すだけで繋げる連携" in body
    assert "CONNECT_SETUP.md" in body
    assert "GOOGLE_CLIENT_ID" in body, "何を入れればいいかが分からない"

    # 登録したら残りから消える。値そのものは出さない。
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid-super-secret")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "csec-super-secret")
    body = client.get("/diagnose").text
    assert "cid-super-secret" not in body
    assert "csec-super-secret" not in body
    got = client.get("/diagnose").json()["押すだけで繋げる連携"]
    assert got["登録済み"]["Google"] is True, got


def test_diagnose_never_leaks_any_configured_secret(monkeypatch):
    """診断は認証なしで読める。ここから鍵が読めては元も子もない。"""
    from fastapi.testclient import TestClient

    from main import app

    secrets = {
        "APP_TOKEN": "tok-secret-1", "SUPABASE_SERVICE_KEY": "svc-secret-2",
        "SUPABASE_JWT_SECRET": "jwt-secret-3", "GEMINI_API_KEY": "sk-secret-4",
        "KEYCHAIN_SECRET": "kc-secret-5",
    }
    for k, v in secrets.items():
        monkeypatch.setenv(k, v)

    body = TestClient(app).get("/diagnose").text
    leaked = [k for k, v in secrets.items() if v in body]
    assert leaked == [], f"診断から漏れている: {leaked}"


def test_the_build_marker_moves_with_the_code():
    """「直したはずなのに直らない」ときに、届いているかを確かめる目印。

    止まっていると、その用を成さない（実際 8月のまま止まっていた）。
    ここでは形だけを見る——日付と版が入っていること。
    """
    import main
    assert re.match(r"^\d{4}\.\d{2}\.\d{2} · api-r\d+", main.APP_VERSION), main.APP_VERSION
