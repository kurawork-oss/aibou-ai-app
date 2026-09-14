# test_guide.py — 使い方ガイドの検証
#
# ここが壊れると「説明と実物が食い違うアプリ」になる。特に確かめたいのは
#   ・画面のガイドとCHATの説明が同じ出どころから来ていること
#   ・ベータの注意（データの置き場）が確実に、かつ実際の設定どおりに載ること
#   ・実装に無い機能を説明していないこと
#   ・全モードの説明書に、実在する画面写真が全部そろっていること

import os

from fastapi.testclient import TestClient

import config
import guide
import main
from main import app

client = TestClient(app)

# 画面写真の置き場（webapp が配信する public/）。api/ の1つ上がリポジトリ直下。
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(_REPO, "webapp", "public")


def test_sections_have_the_shape_the_ui_expects():
    for s in guide.sections():
        assert set(s) >= {"id", "title", "summary", "steps", "notes"}
        assert s["title"] and s["summary"]
        assert isinstance(s["steps"], list) and isinstance(s["notes"], list)


def test_ids_are_unique():
    ids = [s["id"] for s in guide.sections()]
    assert len(ids) == len(set(ids))


def test_sections_are_a_copy_so_callers_cannot_corrupt_the_source():
    got = guide.sections()
    got[0]["title"] = "書き換え"
    assert guide.sections()[0]["title"] != "書き換え"


def test_beta_section_explains_where_data_lives():
    """データの置き場は、隠すと事故になる。必ず載っていること。"""
    beta = next(s for s in guide.sections() if s["id"] == "beta")
    joined = beta["summary"] + " ".join(beta["notes"])
    assert "ベータ" in joined
    assert "自分" in joined and "Supabase" in joined


def test_guide_tells_people_to_connect_their_own_database_first():
    """繋ぐまで保存されない、は最初に伝えないと「消えた」事故になる。"""
    db = next(s for s in guide.sections() if s["id"] == "database")
    joined = db["summary"] + " ".join(db["steps"]) + " ".join(db["notes"])
    assert "保存されません" in joined or "保存されない" in joined
    assert "service_role" in joined
    assert "設定" in joined and "KEYCHAIN" in joined


def test_chat_prompt_says_do_not_make_things_up():
    """でっち上げ禁止は、いつでも付いている。"""
    block = guide.prompt_block()
    assert "でっち上げ" in block or "あるかのように答えない" in block
    # できることは静的な文章ではなく、調べてから答える
    assert "self_check" in block


def test_unsaved_users_are_warned(monkeypatch):
    """繋ぐまでは保存されない、は**繋いでいない人にだけ**言う。

    ここを全員に毎回送っていた。繋いでいる人にとっては毎回出てくる
    間違った注意書きで、そのぶん毎メッセージ長くなる。
    逆に繋いでいない人へ言わないのは危ない——残っていると思ったまま
    使い続け、再読み込みで消えて初めて気づく。
    """
    monkeypatch.setattr(main.config, "storage_state", lambda: "memory")
    p = main.build_system_prompt("AIbou", "", "")
    assert "残らない" in p or "保存されない" in p
    assert "つなぐ" in p or "繋ぐ" in p


def test_connected_users_are_not_warned(monkeypatch):
    monkeypatch.setattr(main.config, "storage_state", lambda: "personal")
    p = main.build_system_prompt("AIbou", "", "")
    assert "どこにも残らない" not in p


def test_chat_system_prompt_includes_the_guide():
    p = main.build_system_prompt("AIbou", "", "")
    assert "AIbouについて" in p
    assert "self_check" in p


def test_guide_endpoint():
    r = client.get("/guide")
    assert r.status_code == 200
    d = r.json()
    assert d["app"] and d["beta"] is True
    assert len(d["sections"]) == d["section_count"] >= 4
    assert len(d["modes"]) == d["mode_count"] >= 10
    # 件数キーが本体を上書きしていないこと（実際に踏んだ不具合）
    assert isinstance(d["sections"], list) and isinstance(d["modes"], list)


def test_shared_data_follows_the_actual_setup(monkeypatch):
    """データの置き場の説明が、固定値ではなく実際の設定から出ていること。"""
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "")
    assert guide.status()["shared_data"] is True       # 利用者を識別できない=共有
    monkeypatch.setattr(config, "SUPABASE_JWT_SECRET", "secret")
    assert guide.status()["shared_data"] is False      # 各自のDBへ振り分けられる


# ── 全モードの説明書 ───────────────────────────────────────────────
def test_modes_have_the_shape_the_ui_expects():
    for m in guide.modes():
        assert set(m) >= {"id", "label", "name", "image", "what", "how", "tips"}
        assert m["label"] and m["name"] and m["what"]
        assert isinstance(m["how"], list) and isinstance(m["tips"], list)


def test_mode_ids_are_unique():
    ids = [m["id"] for m in guide.modes()]
    assert len(ids) == len(set(ids))


def test_modes_are_a_copy_so_callers_cannot_corrupt_the_source():
    got = guide.modes()
    got[0]["what"] = "書き換え"
    assert guide.modes()[0]["what"] != "書き換え"


def test_every_mode_has_a_screenshot_that_actually_ships():
    """説明書に画像の穴が空くのを防ぐ。

    パスだけ書いてファイルを置き忘れると、画面には alt テキストだけが並ぶ。
    ブラウザで開くまで気づけないので、ここで落とす。
    """
    for m in guide.modes():
        assert m["image"].startswith("/guide/"), m["image"]
        path = os.path.join(PUBLIC_DIR, m["image"].lstrip("/"))
        assert os.path.isfile(path), f"画面写真が無い: {m['image']}"
        assert os.path.getsize(path) > 2000, f"画面写真が壊れている: {m['image']}"


def test_every_screen_in_the_launcher_is_documented():
    """ランチャーに出る画面は、全部説明書にあること（説明の取りこぼし防止）。"""
    documented = {m["label"] for m in guide.modes()}
    for label in ["CHAT", "HOME", "ME", "TASKS", "BOARD", "VAULT", "CODE",
                  "STUDIO", "CAPTURE", "SNS", "INCOME", "AUTO", "ARCHIVE", "EXTEND"]:
        assert label in documented, f"説明書に無い画面がある: {label}"


def test_guide_does_not_promise_features_that_do_not_exist():
    """説明にあるモード名は、実際に画面がある名前だけにする。"""
    text = " ".join(s["summary"] + " ".join(s["steps"]) for s in guide.sections())
    text += " ".join(m["what"] + " ".join(m["how"]) + " ".join(m["tips"])
                     for m in guide.modes())
    modes = ["HOME", "CHAT", "ME", "TASKS", "BOARD", "VAULT", "CODE",
             "STUDIO", "CAPTURE", "SNS", "INCOME", "AUTO", "ARCHIVE", "EXTEND"]
    # 設定のタブ名（app/page.tsx の SettingsTab と同じ）
    settings_tabs = ["CORE", "PERSONA", "KEYCHAIN", "HF", "DIAGNOSTICS"]
    # 画面の中にある実在のUI名（押せるタブ・見出し）
    ui_parts = ["AGENT", "CONSOLE", "WHITEBOARD", "AUTOMATION"]
    # KEYCHAIN に実在する鍵の名前を分解した断片（GEMINI_API_KEY など）
    key_names = ["GEMINI", "HUGGINGFACE", "GITHUB", "API", "TOKEN", "KEY"]
    # 画面名ではない語（キー名・サービス名・一般的な略語）
    other = ["SHIFT", "PDF", "AI", "LP", "HP", "WEB", "LINE", "ZIP", "CSV",
             "URL", "PAT", "OK", "DB", "MTG", "HTML"]
    allowed = modes + settings_tabs + ui_parts + key_names + other
    # 日本語に直接くっついた語（「定例MTG」「WEBアプリ」など）も拾う。\b は
    # 日本語の文字を単語構成文字として扱うため境界が立たず、素通りしてしまう。
    import re
    for word in re.findall(r"(?<![A-Za-z])[A-Z]{2,}(?![A-Za-z])", text):
        assert word in allowed, f"実在しない画面名が説明に出ている: {word}"
