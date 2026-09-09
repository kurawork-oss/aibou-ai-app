# test_capabilities_packs.py — 「できること」の絞り込みと # コマンド
#
# ねらいは2つ。
#
# ① AIに毎回送る道具の説明を、使う物だけにする
#    全部で約3,900文字あり、毎リクエストに丸ごと乗っていた。送る量が増えるほど
#    返事は遅くなり、選択肢が多いほど道具の選び間違いも増える
#    （「ドライブに作って」で別の道具が選ばれたのが、まさにこれ）。
#
# ② # で、AIに考えさせずに道具へ直行する
#    ただし「# を覚えないと使えない」は失敗。ふつうの言葉でも同じことが
#    できることを、ここで担保する。

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent
import capabilities as cap
import keychain
import tools
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean():
    keychain.delete_key("FEATURE_PACKS")
    keychain._mem_keys.clear()
    os.environ.pop("FEATURE_PACKS", None)
    yield
    keychain.delete_key("FEATURE_PACKS")
    keychain._mem_keys.clear()
    os.environ.pop("FEATURE_PACKS", None)


# ── ① 送る量を減らす ─────────────────────────────────────────────────
def test_the_prompt_only_carries_the_tools_actually_in_use():
    full = tools.TOOLS_DOC
    now = cap.tools_doc()
    assert len(now) < len(full), "絞り込みが効いていない"
    # 既定で切ってあるパックの道具は入らない
    assert "enqueue_income" not in now       # 副業（既定OFF）
    assert "create_automation" not in now    # 開発（既定OFF）
    # よく使う物は入る
    assert "add_task" in now and "generate_image" in now


def test_an_unconnected_tool_stays_visible_to_the_ai(monkeypatch):
    """繋いでいなくても、道具はAIから隠さないこと。

    隠すと、「ドライブに作って」と頼まれたAIがその道具を知らないまま、
    一番近い別の道具（AIbou内に保存するだけ）を選び「作成しました」と答える。
    以前まさにこれが起きた。残しておけば正しく選び、「Google未接続です」と
    正直に返せる。嘘をつかないほうを取る。
    """
    monkeypatch.setattr(cap, "_connected", lambda name: False)
    doc = cap.tools_doc()
    assert "drive_upload" in doc
    assert "google_doc" in doc


def test_an_unconnected_command_is_not_offered_as_a_shortcut(monkeypatch):
    """一方 # の一覧には出さない。押しても必ず失敗する近道は、案内しない。"""
    monkeypatch.setattr(cap, "_connected", lambda name: False)
    assert not any(c["cmd"] == "ドライブ" for c in cap.available())
    assert cap.parse("#ドライブ メモ.txt") is None

    monkeypatch.setattr(cap, "_connected", lambda name: True)
    assert any(c["cmd"] == "ドライブ" for c in cap.available())


def test_the_agent_uses_the_filtered_list():
    """絞ったものが、実際にAIへ渡っていること（作っただけで繋がっていない、を防ぐ）。"""
    assert agent._tools_doc() == cap.tools_doc()
    assert len(agent._tools_doc()) < len(tools.TOOLS_DOC)


def test_filtering_never_breaks_the_conversation(monkeypatch):
    """絞り込みが壊れても、会話は止まらないこと。"""
    def boom():
        raise RuntimeError("台帳が読めない")
    monkeypatch.setattr(cap, "tools_doc", boom)
    assert agent._tools_doc() == tools.TOOLS_DOC   # 全部入りに落ちる


def test_every_advertised_command_has_a_real_implementation():
    """画面に出す入口が、実装の無い道具を指していないこと。"""
    for c in cap.CAPABILITIES:
        if c.get("tool"):
            assert c["tool"] in tools._DISPATCH, f"{c['cmd']} の道具がない"
            assert c["tool"] in tools.TOOL_DOCS, f"{c['cmd']} の説明がない"


# ── ② # コマンド ────────────────────────────────────────────────────
def test_a_command_goes_straight_to_the_tool():
    """AIに考えさせず、そのまま実行されること（これが速さの理由）。"""
    r = client.post("/command", json={"text": "#状況"}).json()
    assert r["ok"] is True and r["kind"] == "done"
    assert r["tool"] == "watch_report"


def test_a_command_can_be_abbreviated():
    r = client.post("/command", json={"text": "#状"}).json()
    assert r.get("tool") == "watch_report"


def test_full_width_hash_and_space_work():
    """＃ と全角スペースで打つ人がいる。そこで落とさない。"""
    got = cap.parse("＃タスク　牛乳を買う")
    assert got and got["capability"]["cmd"] == "タスク" and got["rest"] == "牛乳を買う"


def test_a_command_can_be_typed_in_kana():
    """日本語入力は必ずかなを通る。

    漢字の前方一致だけだと、「#がぞう」と打った人は変換を確定するまで
    何も出ない。打ちながら選ぶという使い方そのものが成り立たなくなる。
    """
    assert cap.find("がぞう")["cmd"] == "画像"
    assert cap.find("image")["cmd"] == "画像"          # ローマ字でも
    got = cap.parse("#がぞう 猫の絵")
    assert got and got["capability"]["cmd"] == "画像" and got["rest"] == "猫の絵"


def test_every_command_can_be_reached_without_conversion():
    """すべての入口に、かな・英語のよみが付いていること。

    1つでも抜けると、その機能だけ「変換しないと呼べない」ことになる。
    抜けても他が動くので、静かに使われなくなる壊れ方をする。
    """
    missing = [c["cmd"] for c in cap.CAPABILITIES if not (c.get("yomi") or "").strip()]
    assert missing == [], f"よみが無い: {missing}"


def test_an_ambiguous_kana_asks_instead_of_picking_one():
    """絞れないときに勝手に決めないこと（取り違えて走るほうが困る）。

    どの字が重なるかは中身が増えれば変わるので、実際に重なっている
    ものを探してから確かめる（決め打ちにすると、増減のたびに嘘になる）。
    探す先は find() と同じ「いま出せる入口」にする。繋いでいない物を
    含めて数えると、実際には重なっていない字で落ちる。
    """
    heads = [(c.get("yomi") or "").split()[0][:1] for c in cap.available(True)]
    shared = [h for h in set(heads) if h and heads.count(h) > 1]
    assert shared, "前提が崩れた（重なるよみが1つも無い）"
    for h in shared:
        assert cap.find(h) is None, f"「{h}」で1つに決めてしまっている"


def test_two_different_things_do_not_share_a_reading():
    """よみがまるごと同じ入口を作らないこと。

    「資料」（作る）と「しりょう」（保管庫から答える）が両方あって、
    #しり まで打つと2つに割れ、どちらも出せなくなっていた。
    やることが別なら、名前も分ける。
    """
    seen: dict[str, str] = {}
    for c in cap.CAPABILITIES:
        key = (c.get("yomi") or "").split()[0]
        if not key:
            continue
        assert key not in seen, f"よみが同じ: {seen.get(key)} と {c['cmd']}（{key}）"
        seen[key] = c["cmd"]


def test_an_unknown_command_is_not_executed_but_passed_on():
    """打ち間違いで会話が止まらないこと。"""
    r = client.post("/command", json={"text": "#でたらめ なにか"}).json()
    assert r["ok"] is False and r["unknown"] is True
    assert cap.parse("#でたらめ なにか") is None
    assert cap.parse("ふつうの文章") is None


def test_a_command_missing_its_argument_asks_instead_of_guessing():
    r = client.post("/command", json={"text": "#画像"}).json()
    assert r["kind"] == "needs_arg"
    assert "どんな絵か" in r["message"]


def test_a_command_that_cannot_be_split_is_handed_to_the_ai():
    """「#予定 明日15時に歯医者」は、日付と用件に機械的に割れない。

    無理に切ると取り違えるので、そこはAIに任せる。ここを頑張ると
    「#を使うと変な予定が入る」になり、いちばん困る。
    """
    r = client.post("/command", json={"text": "#予定 明日15時に歯医者"}).json()
    assert r["kind"] == "delegate"


def test_a_view_command_just_opens_the_screen():
    r = client.post("/command", json={"text": "#ボード"}).json()
    assert r["ok"] is True and r["kind"] == "view" and r["view"] == "board"


def test_hash_is_a_shortcut_not_a_requirement():
    """# で呼べることは、ふつうの言葉でも頼めること。

    ここが崩れると「呪文を覚えないと使えないアプリ」になる。
    """
    doc = cap.tools_doc()
    for c in cap.available():
        if c.get("tool"):
            assert c["tool"] in doc, (
                f"#{c['cmd']} は直行できるのに、AIには渡っていない。"
                "ふつうの言葉で頼めなくなっている")


# ── パックの切り替え ─────────────────────────────────────────────────
def test_packs_change_what_is_available():
    before = {c["cmd"] for c in cap.available()}
    assert "副業" not in before

    cap.set_packs(["make", "income"])
    after = {c["cmd"] for c in cap.available()}
    assert "副業" in after
    assert "副業" in cap.status()["commands"][0]["cmd"] or any(
        c["cmd"] == "副業" for c in cap.status()["commands"])


def test_the_basic_pack_cannot_be_switched_off():
    """ここを切ると相棒がほぼ何もできなくなる。切らせない。"""
    cap.set_packs([])                      # 全部切ろうとする
    assert "core" in cap.enabled_packs()
    assert any(c["cmd"] == "タスク" for c in cap.available())


def test_owner_only_packs_are_hidden_from_others():
    keys = {p["key"] for p in cap.status(is_owner=False)["packs"]}
    assert "income" not in keys
    assert "core" in keys


def test_packs_endpoint_round_trip():
    r = client.post("/capabilities/packs", json={"packs": ["make", "dev"]})
    assert r.status_code == 200
    assert set(r.json()["packs"]) >= {"core", "make", "dev"}

    d = client.get("/capabilities").json()
    on = {p["key"] for p in d["packs"] if p["enabled"]}
    assert {"core", "make", "dev"} <= on
    assert "share" not in on


def test_status_tells_the_screen_what_it_needs():
    d = client.get("/capabilities").json()
    assert d["packs"] and d["commands"]
    core = next(p for p in d["packs"] if p["key"] == "core")
    assert core["always"] is True          # 切れないことを画面に伝える
    one = next(c for c in d["commands"] if c["cmd"] == "画像")
    assert one["direct"] is True and one["arg"] and one["label"]


# ── 危なさの段階（0 読むだけ 〜 3 取り返せない） ──────────────────────
def test_every_tool_has_an_explicit_risk_level():
    """段階の書き忘れが無いこと。

    書き忘れた道具は、実行時には「必ず確認」に回る（安全側）が、
    害の無い道具で確認が出るのも困る。開発の時点で気づけるようにする。
    """
    import risk
    missing = sorted(set(tools._DISPATCH) - set(risk.LEVELS))
    assert missing == [], f"段階が書かれていない道具: {missing}"


def test_reading_and_local_changes_do_not_interrupt():
    import risk
    for t in ("web_search", "watch_report", "email_inbox", "calendar_list"):
        assert risk.needs_confirmation(t, approval_mode=False) is False
        assert risk.needs_confirmation(t, approval_mode=True) is False, \
            f"{t} は読むだけなので、承認モードでも聞く必要がない"
    for t in ("add_task", "board_add_note", "generate_image"):
        assert risk.needs_confirmation(t, approval_mode=False) is False


def test_changes_that_leave_the_app_ask_in_approval_mode():
    import risk
    for t in ("drive_upload", "calendar_add", "notion_add"):
        assert risk.needs_confirmation(t, approval_mode=False) is False
        assert risk.needs_confirmation(t, approval_mode=True) is True


def test_irreversible_work_always_asks():
    """ここがこの変更の芯。設定の組み合わせで黙って送られる道を作らない。"""
    import risk
    for t in ("send_email", "notify", "enqueue_income", "run_automation"):
        assert risk.needs_confirmation(t, approval_mode=False) is True
        assert risk.needs_confirmation(t, approval_mode=True) is True
        assert risk.describe(t)["always_confirm"] is True


def test_an_unclassified_tool_errs_towards_asking():
    import risk
    assert risk.needs_confirmation("これから足す道具", approval_mode=False) is True


def test_irreversible_tools_explain_what_happens():
    """確認を出すなら、何が起きるのかまで言うこと。"""
    import risk
    for t in ("send_email", "notify", "enqueue_income", "run_automation"):
        assert risk.describe(t)["why"], f"{t} に説明が無い"


def test_risk_endpoint():
    r = client.get("/risk")
    assert r.status_code == 200
    d = r.json()
    by = {x["tool"]: x for x in d["levels"]}
    assert by["send_email"]["level"] == 3 and by["send_email"]["always_confirm"] is True
    assert by["web_search"]["level"] == 0
    assert d["labels"]["3"] == "取り返せない"
