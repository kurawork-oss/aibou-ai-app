"""
手元のパソコンで動く相棒（localagent.py + agent_local/aibou_local.py）。

いちばん守りたいこと
--------------------
この機能は、**クラウドのAIにパソコンの中を触らせる**もの。ここが破られると、
ほかで何をしていても意味が無い。

  ・許したフォルダの外へ出られないか（`..` とシンボリックリンク）
  ・他人の相棒に仕事を頼めないか
  ・消えないか（上書きで元が消えないか）
  ・切ってある物（開く・画面を撮る）が動かないか

「繋がっていないときに黙らないか」も見る。相棒が止まっているのに
「書いておきました」と言うのが、この機能でいちばん困る嘘になる。
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "agent_local"))

import localagent


@pytest.fixture(autouse=True)
def clean():
    localagent.reset()
    yield
    localagent.reset()


# ── つなぐ（何台でも） ──────────────────────────────────────────────

def _one(user="u1", name="ノート"):
    """1台繋いで (合言葉, 台のID) を返す。"""
    got = localagent.pair(user, name)
    assert got["ok"] is True
    return got["token"], got["device"]


def test_the_token_is_shown_once_and_not_stored_as_is():
    """漏れたらそのままパソコンの中を取りに行ける物なので、そのままは置かない。"""
    token, device = _one()
    assert len(token) > 20
    stored = localagent._store.users["u1"][device]["token_hash"]
    assert token not in stored
    assert localagent.whoami(token) == ("u1", device)


def test_a_wrong_token_names_nobody():
    _one()
    assert localagent.whoami("でたらめ") == ("", "")
    assert localagent.whoami("") == ("", "")


def test_a_second_machine_does_not_kick_out_the_first():
    """ここがこの回の本題。

    前は `devices[user_id]` が1件の辞書で、2台目を繋ぐと1台目の合言葉が
    死んだ（そう振る舞うことをテストで固定してすらいた）。
    「スマホとノートPCとデスクトップで使いたい」は、それでは表せない。
    """
    note, note_id = _one(name="ノート")
    desk, desk_id = _one(name="デスクトップ")
    assert note_id != desk_id
    # 両方とも、自分の台として通る
    assert localagent.whoami(note) == ("u1", note_id)
    assert localagent.whoami(desk) == ("u1", desk_id)
    assert len(localagent.status("u1")["devices"]) == 2


def test_the_same_name_twice_is_made_distinguishable():
    """同じ名前が並ぶと、どちらに頼んだか言えなくなる。"""
    localagent.pair("u1", "パソコン")
    second = localagent.pair("u1", "パソコン")
    assert second["name"] != "パソコン"


def test_there_is_a_limit_on_how_many_machines():
    for _ in range(localagent.MAX_DEVICES):
        assert localagent.pair("u1", "")["ok"] is True
    over = localagent.pair("u1", "")
    assert over["ok"] is False and "上限" in over["error"]


def test_one_persons_token_cannot_reach_another():
    """ここが抜けると、合言葉1つで他人のパソコンに仕事を頼める。"""
    a, a_id = _one("u1")
    b_token, b_id = _one("u2")
    assert localagent.whoami(a) == ("u1", a_id)
    localagent.submit("u2", "read", {"path": "秘密.md"})
    # u1 の台として取りに来ても、u2 の仕事は渡らない
    assert localagent.take("u1", a_id, wait=0.05) is None


def test_one_machine_cannot_take_another_machines_work():
    """同じ人の中でも、台ごとの列は混ざらない。

    ノートに頼んだ仕事をデスクトップが持って行くと、**別のパソコンの
    ファイルを読んで返す**ことになる。
    """
    _note, note_id = _one(name="ノート")
    _desk, desk_id = _one(name="デスクトップ")
    localagent.take("u1", note_id, wait=0.01)     # 両方を「動いている」に
    localagent.take("u1", desk_id, wait=0.01)
    localagent.submit("u1", "read", {"path": "a.md"}, device="ノート")
    assert localagent.take("u1", desk_id, wait=0.05) is None
    job = localagent.take("u1", note_id, wait=0.05)
    assert job and job["params"]["path"] == "a.md"


def test_unpairing_one_leaves_the_other():
    note, note_id = _one(name="ノート")
    desk, _desk_id = _one(name="デスクトップ")
    got = localagent.unpair("u1", "ノート")
    assert got["removed"] == 1
    assert localagent.whoami(note) == ("", "")
    assert localagent.whoami(desk)[0] == "u1"


def test_unpairing_everything_leaves_nothing():
    note, _ = _one(name="ノート")
    localagent.pair("u1", "デスクトップ")
    assert localagent.unpair("u1")["removed"] == 2
    assert localagent.whoami(note) == ("", "")
    assert localagent.status("u1")["paired"] is False


def test_a_machine_can_be_renamed():
    """「ノートの資料を読んで」と言えるようにするため。"""
    _t, device = _one(name="パソコン")
    assert localagent.rename("u1", device, "しごとのノート")["ok"] is True
    assert localagent.status("u1")["devices"][0]["name"] == "しごとのノート"
    assert localagent.rename("u1", "無い台", "x")["ok"] is False


# ── 繋がっているか、正直に言う ──────────────────────────────────────

def test_says_plainly_when_nothing_is_paired():
    st = localagent.status("u1")
    assert st["paired"] is False and st["online"] is False
    assert st["devices"] == []
    assert st["why"] and st["next"]


def test_paired_but_never_seen_is_not_called_online():
    """「合言葉を作った」と「動いている」は別のこと。"""
    _one()
    st = localagent.status("u1")
    assert st["paired"] is True
    assert st["online"] is False
    assert "動いていません" in st["why"]


def test_coming_to_ask_counts_as_alive():
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)
    st = localagent.status("u1")
    assert st["online"] is True
    assert st["devices"][0]["online"] is True


def test_one_machine_online_is_enough_to_be_connected():
    _n, note_id = _one(name="ノート")
    localagent.pair("u1", "デスクトップ")       # 繋いだが動いていない
    localagent.take("u1", note_id, wait=0.01)
    st = localagent.status("u1")
    assert st["online"] is True
    assert [d["online"] for d in st["devices"]] == [True, False]


# ── どの台に頼むか ──────────────────────────────────────────────────

def test_with_one_machine_running_it_just_goes_there():
    _t, device = _one(name="ノート")
    localagent.take("u1", device, wait=0.01)
    got = localagent.pick("u1")
    assert got["ok"] is True and got["device"] == device


def test_with_two_machines_running_it_asks_instead_of_guessing():
    """**勝手に選ばない。**

    ファイルは台ごとに違う。黙って選ぶと「ノートを読んだつもりが
    デスクトップだった」が起きる。読み違いは気づきにくく、書き違いは
    取り返しがつかない。
    """
    _n, note_id = _one(name="ノート")
    _d, desk_id = _one(name="デスクトップ")
    localagent.take("u1", note_id, wait=0.01)
    localagent.take("u1", desk_id, wait=0.01)
    got = localagent.pick("u1")
    assert got["ok"] is False
    assert set(got["choose"]) == {"ノート", "デスクトップ"}
    assert "ノート" in got["error"] and "デスクトップ" in got["error"]
    # 名前を言えば、そこへ行く
    assert localagent.pick("u1", "デスクトップ")["device"] == desk_id


def test_naming_a_machine_that_is_not_running_says_so():
    _n, note_id = _one(name="ノート")
    localagent.pair("u1", "デスクトップ")       # 動いていない
    localagent.take("u1", note_id, wait=0.01)
    got = localagent.pick("u1", "デスクトップ")
    assert got["ok"] is False and "動いていません" in got["error"]


def test_naming_a_machine_that_does_not_exist_lists_the_real_ones():
    _one(name="ノート")
    got = localagent.pick("u1", "会社のiMac")
    assert got["ok"] is False and "ノート" in got["error"]


def test_nothing_running_is_reported_as_nothing_running():
    _one()
    got = localagent.pick("u1")
    assert got["ok"] is False and "動いている台がありません" in got["error"]


# ── 仕事を渡す ──────────────────────────────────────────────────────

def test_cannot_ask_for_a_job_we_do_not_know():
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)
    got = localagent.submit("u1", "delete", {"path": "a"})
    assert got["ok"] is False


def test_cannot_ask_before_pairing():
    got = localagent.submit("u1", "read", {"path": "a"})
    assert got["ok"] is False
    assert "繋いでいません" in got["error"]


def test_a_job_waits_until_the_helper_comes():
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)
    localagent.submit("u1", "read", {"path": "a.md"})
    job = localagent.take("u1", device, wait=0.1)
    assert job and job["kind"] == "read" and job["params"]["path"] == "a.md"
    # 2回は渡らない
    assert localagent.take("u1", device, wait=0.05) is None


def test_waiting_ends_when_a_job_arrives():
    """1秒ごとに聞きに来させると、平均0.5秒遅れる。待たせて、来たら起こす。"""
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)

    def later():
        time.sleep(0.2)
        localagent.submit("u1", "read", {"path": "a"})

    threading.Thread(target=later, daemon=True).start()
    start = time.time()
    job = localagent.take("u1", device, wait=5.0)
    assert job is not None
    assert time.time() - start < 2.0


def test_stale_jobs_are_not_handed_over(monkeypatch):
    """相棒が止まっているあいだに溜まった物は、渡さない（もう誰も待っていない）。"""
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)
    localagent.submit("u1", "read", {"path": "a"})
    monkeypatch.setattr(localagent, "JOB_TTL", -1)
    assert localagent.take("u1", device, wait=0.05) is None


def test_a_result_comes_back_to_the_one_who_asked():
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)
    sent = localagent.submit("u1", "read", {"path": "a"})
    localagent.deliver("u1", device, sent["job_id"], {"ok": True, "text": "中身"})
    got = localagent.collect(sent["job_id"], timeout=1.0)
    assert got["ok"] is True and got["text"] == "中身"


def test_the_answer_says_which_machine_did_it():
    """2台あるとき、これが無いとどちらを読んだのか分からない。"""
    _t, device = _one(name="ノート")
    localagent.take("u1", device, wait=0.01)

    def answer():
        time.sleep(0.1)
        job = localagent.take("u1", device, wait=2.0)
        localagent.deliver("u1", device, job["id"], {"ok": True, "message": "読んだ"})

    threading.Thread(target=answer, daemon=True).start()
    got = localagent.run("u1", "read", {"path": "a"}, timeout=3.0)
    assert got["ok"] is True and got["device_name"] == "ノート"


def test_no_answer_is_reported_as_no_answer():
    """ここで「書いておきました」と言うのが、この機能でいちばん困る嘘。"""
    _t, device = _one()
    localagent.take("u1", device, wait=0.01)
    sent = localagent.submit("u1", "write", {"path": "a", "text": "x"})
    got = localagent.collect(sent["job_id"], timeout=0.2)
    assert got["ok"] is False
    assert "返事がありません" in got["error"]


# ── 手元側の門番（agent_local/aibou_local.py） ──────────────────────

@pytest.fixture
def workspace(tmp_path):
    (tmp_path / "メモ").mkdir()
    (tmp_path / "メモ" / "買い物.md").write_text("にんじん\n", encoding="utf-8")
    (tmp_path / ".隠し").write_text("見せない", encoding="utf-8")
    outside = tmp_path.parent / "そとがわ.txt"
    outside.write_text("読まれてはいけない", encoding="utf-8")
    return tmp_path, outside


def _runner(root, **kw):
    import aibou_local
    guard = aibou_local.Guard([str(root)], kw.pop("vault", ""), kw.pop("daily", "日誌"))
    return aibou_local.Runner(guard, kw.pop("allow_open", False),
                              kw.pop("allow_screen", False), lambda *_: None)


@pytest.mark.parametrize("bad", [
    "../そとがわ.txt",
    "メモ/../../そとがわ.txt",
    "/etc/passwd",
    "メモ/../../../../../../etc/passwd",
    "",
])
def test_cannot_escape_the_allowed_folder(workspace, bad):
    """文字列のままだと「メモの中」に見える指定がある。実際の道に直して比べる。"""
    root, _ = workspace
    got = _runner(root).do({"kind": "read", "params": {"path": bad}})
    assert got["ok"] is False


def test_a_symlink_out_of_the_folder_is_refused(workspace):
    root, outside = workspace
    link = root / "近道.txt"
    try:
        link.symlink_to(outside)
    except OSError:                                        # pragma: no cover
        pytest.skip("この環境ではシンボリックリンクを作れない")
    got = _runner(root).do({"kind": "read", "params": {"path": "近道.txt"}})
    assert got["ok"] is False
    assert "外です" in got["error"]


def test_reads_inside_the_folder(workspace):
    root, _ = workspace
    got = _runner(root).do({"kind": "read", "params": {"path": "メモ/買い物.md"}})
    assert got["ok"] is True and "にんじん" in got["text"]


def test_hidden_files_are_not_listed(workspace):
    root, _ = workspace
    got = _runner(root).do({"kind": "list", "params": {}})
    assert got["ok"] is True
    assert all(not i["name"].startswith(".") for i in got["items"])


def test_big_files_are_not_read(workspace):
    """読んだ物はAIへ渡る。大きい物は渡さない。"""
    import aibou_local
    root, _ = workspace
    big = root / "おおきい.txt"
    big.write_text("あ" * (aibou_local.MAX_READ + 10), encoding="utf-8")
    got = _runner(root).do({"kind": "read", "params": {"path": "おおきい.txt"}})
    assert got["ok"] is False and "大きすぎます" in got["error"]


def test_overwriting_keeps_the_old_content(workspace):
    """消さないのが決まり。上書きしても、元は .bak に残る。"""
    root, _ = workspace
    got = _runner(root).do({"kind": "write",
                            "params": {"path": "メモ/買い物.md", "text": "だいこん"}})
    assert got["ok"] is True
    assert (root / "メモ" / "買い物.md").read_text(encoding="utf-8") == "だいこん"
    assert (root / "メモ" / "買い物.md.bak").read_text(encoding="utf-8") == "にんじん\n"


def test_append_adds_without_losing(workspace):
    root, _ = workspace
    _runner(root).do({"kind": "append",
                      "params": {"path": "メモ/買い物.md", "text": "たまねぎ"}})
    body = (root / "メモ" / "買い物.md").read_text(encoding="utf-8")
    assert "にんじん" in body and "たまねぎ" in body


def test_there_is_no_delete_and_no_shell():
    """作っていない物は、頼めない。"""
    assert "delete" not in localagent.JOBS
    assert "run" not in localagent.JOBS
    import aibou_local
    assert not hasattr(aibou_local.Runner, "_delete")
    assert not hasattr(aibou_local.Runner, "_run")


def test_open_and_screen_are_off_unless_asked(workspace):
    root, _ = workspace
    r = _runner(root)
    assert r.do({"kind": "open", "params": {"path": "メモ/買い物.md"}})["ok"] is False
    assert r.do({"kind": "shot", "params": {}})["ok"] is False


def test_unknown_jobs_are_refused(workspace):
    root, _ = workspace
    got = _runner(root).do({"kind": "rm", "params": {}})
    assert got["ok"] is False and "知りません" in got["error"]


# ── Obsidian（仕様§26） ─────────────────────────────────────────────

def test_the_daily_note_goes_into_the_vault(workspace, tmp_path):
    import datetime as dt
    root, _ = workspace
    vault = tmp_path / "vault"
    (vault / "日誌").mkdir(parents=True)
    got = _runner(root, vault=str(vault)).do(
        {"kind": "append", "params": {"vault": "daily", "text": "今日は寒い"}})
    assert got["ok"] is True
    name = dt.date.today().strftime("%Y-%m-%d") + ".md"
    assert "今日は寒い" in (vault / "日誌" / name).read_text(encoding="utf-8")


def test_without_a_vault_it_says_so(workspace):
    root, _ = workspace
    got = _runner(root).do({"kind": "append", "params": {"vault": "daily", "text": "x"}})
    assert got["ok"] is False and "vault" in got["error"]


# ── 道具として ──────────────────────────────────────────────────────

def test_tools_are_registered():
    import risk
    import tools
    import toolschema
    for name in ("local_list", "local_read", "local_write", "local_append",
                 "obsidian_note"):
        assert name in tools.TOOL_DOCS, name
        assert name in tools._DISPATCH, name
        assert name in toolschema.SCHEMAS, name
        assert risk.level(name) in (1, 2), name


def test_reading_a_local_file_asks_first():
    """中身がAIへ渡るので、このアプリの中で完結しない。"""
    import risk
    assert risk.needs_confirmation("local_read", True) is True
    assert "AIへ渡ります" in risk.WHY["local_read"]


def test_a_local_file_is_not_an_instruction():
    """手元のファイルにも「これまでの指示は無視して」と書いておける。"""
    import inspect
    import tools
    assert "untrusted.wrap" in inspect.getsource(tools._do_local_read)


def test_the_tool_says_when_nothing_is_connected(monkeypatch):
    import tools
    out = tools.execute_tool("local_read", {"path": "a.md"})
    assert "繋いでいません" in out or "返事がありません" in out


def test_the_tool_does_not_let_the_ai_name_someone_else(monkeypatch):
    """誰の相棒かは、道具の引数ではなく**リクエストの文脈**から引く。

    引数で渡させると、AIが書いた文字列で他人の相棒を名指しできる。
    """
    import config
    import tools
    seen = {}
    monkeypatch.setattr(localagent, "run",
                        lambda uid, kind, params, timeout, device="": seen.update(
                            uid=uid, kind=kind, params=params) or {"ok": True, "text": ""})
    token = config.bind_request_user("u1")
    try:
        # AIが「他人のID」を引数に混ぜても、そちらは使われない
        tools.execute_tool("local_read", {"path": "a.md", "user_id": "u2"})
    finally:
        config.reset_request_user(token)
    assert seen["uid"] == "u1"
    assert "u2" not in str(seen["params"].values())


# ── 通しで（本物のサーバー相手に、本物の相棒を1周させる） ────────────

def test_the_real_helper_talks_to_the_real_server(tmp_path, monkeypatch):
    """ここが通れば、「たぶん動く」ではなく「動いた」と言える。

    FastAPI の口をそのまま立てて、agent_local/aibou_local.py の loop() を
    1周だけ回す。合言葉の受け渡し・仕事の受け取り・結果の返送まで、
    実物どうしで確かめる。
    """
    import aibou_local
    import main
    from fastapi.testclient import TestClient

    (tmp_path / "メモ").mkdir()
    (tmp_path / "メモ" / "買い物.md").write_text("にんじん\n", encoding="utf-8")

    client = TestClient(main.app)
    token = client.post("/local/pair", json={"name": "試験機"}).json()["token"]

    # requests の代わりに、TestClient を使わせる（本物のHTTPの代わり）
    class Session:
        def get(self, url, params=None, headers=None, timeout=None):
            return client.get(url.replace("http://server", ""),
                              params=params, headers=headers)

        def post(self, url, json=None, headers=None, timeout=None):
            return client.post(url.replace("http://server", ""),
                               json=json, headers=headers)

    monkeypatch.setattr(aibou_local.requests, "Session", lambda: Session())

    user_id, device_id = localagent.whoami(token)
    assert user_id and device_id
    # 一度「仕事ある？」と来た台だけが、頼み先として選ばれる
    # （繋いだだけの台に預けても、誰も取りに来ない）
    localagent.take(user_id, device_id, wait=0.01)
    sent = localagent.submit(user_id, "read", {"path": "メモ/買い物.md"})
    assert sent["ok"] is True, sent

    runner = _runner(tmp_path)
    aibou_local.loop("http://server", token, runner, lambda *_: None, once=True)

    got = localagent.collect(sent["job_id"], timeout=1.0)
    assert got["ok"] is True
    assert "にんじん" in got["text"]


def test_a_bad_token_is_turned_away_at_the_door():
    import main
    from fastapi.testclient import TestClient
    client = TestClient(main.app)
    r = client.get("/local/jobs", headers={"X-Local-Token": "nonsense-token"})
    assert r.status_code == 401
    r = client.post("/local/result", json={"job_id": "x", "result": {}},
                    headers={"X-Local-Token": "nonsense-token"})
    assert r.status_code == 401


# ── あなたのブラウザを動かす（いちばん危ない所） ────────────────────

def _chrome_here() -> bool:
    """この環境に本物のブラウザがあるか。無ければ、その分だけ飛ばす。"""
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    import browser
    return bool(browser._find_chrome())


def _browser_runner(root, **kw):
    import aibou_local
    guard = aibou_local.Guard([str(root)], sites=kw.pop("sites", []))
    return aibou_local.Runner(guard, False, False, lambda *_: None,
                              allow_browser=kw.pop("allow_browser", True),
                              profile=kw.pop("profile", str(root / "prof")),
                              headless=True)


def test_browsing_is_off_unless_asked(workspace):
    root, _ = workspace
    r = _browser_runner(root, allow_browser=False, sites=["example.com"])
    got = r.do({"kind": "browse", "params": {"url": "https://example.com"}})
    assert got["ok"] is False and "--allow-browser" in got["error"]


def test_without_a_site_list_nothing_can_be_opened(workspace):
    """「全部」という書き方は用意していない。

    開くのは**本人がログイン済みのブラウザ**。会話に紛れ込んだ一文が
    どこかを開かせたら、その先は本人として操作されることになる。
    「どこを開かれても構わないか」ではなく「この3つなら構う」を先に決める。
    """
    root, _ = workspace
    got = _browser_runner(root, sites=[]).do(
        {"kind": "browse", "params": {"url": "https://example.com"}})
    assert got["ok"] is False and "--site" in got["error"]


@pytest.mark.parametrize("url,ok", [
    ("https://example.com/x", True),
    ("https://www.example.com/x", True),        # 下のドメインは含む
    ("https://notexample.com/x", False),        # 名前が似ているだけの別人
    ("https://example.com.evil.jp/", False),    # 後ろに足しただけの別人
    ("http://evil.example/", False),
    ("file:///etc/passwd", False),
    ("", False),
])
def test_only_the_listed_sites_open(workspace, url, ok):
    import aibou_local
    root, _ = workspace
    g = aibou_local.Guard([str(root)], sites=["example.com"])
    if ok:
        assert g.site(url) == url
    else:
        with pytest.raises(PermissionError):
            g.site(url)


def test_touching_is_always_confirmed():
    """押した先が「送信」かもしれない。そのときは**本人として**送られる。"""
    import risk
    assert risk.level("local_browse_act") == 3
    assert risk.needs_confirmation("local_browse_act", False) is True
    # 「いつも許可」も出さない
    assert risk.may_always_allow("local_browse_act") is False
    assert "取り消せません" in risk.WHY["local_browse_act"]


def test_looking_is_lighter_than_touching():
    import risk
    assert risk.level("local_browse") == 2
    # ただし1枚読んだ後は、行き先がページ由来かもしれないので聞く
    assert risk.needs_confirmation("local_browse", False, external_reads=1) is True


def test_no_way_to_run_javascript_in_your_own_browser():
    import aibou_local
    src = open(aibou_local.__file__).read()
    assert ".evaluate(" not in src
    assert "evaluate" not in aibou_local.BROWSE_ACTIONS


def test_reading_does_not_accept_steps(workspace, monkeypatch):
    """`browse` は読むだけ。手順を混ぜても押さない。"""
    import aibou_local
    root, _ = workspace
    r = _browser_runner(root, sites=["example.com"])
    seen = {}
    monkeypatch.setattr(r, "_drive", lambda p, act: seen.update(act=act) or {"ok": True})
    r.do({"kind": "browse", "params": {"url": "https://example.com",
                                       "steps": [{"do": "click", "target": "送信"}]}})
    assert seen["act"] is False
    r.do({"kind": "browse_act", "params": {"url": "https://example.com"}})
    assert seen["act"] is True


def test_the_tools_are_registered():
    import risk
    import tools
    import toolschema
    for name in ("local_browse", "local_browse_act"):
        assert name in tools.TOOL_DOCS, name
        assert name in tools._DISPATCH, name
        assert name in toolschema.SCHEMAS, name
    assert "browse" in localagent.JOBS and "browse_act" in localagent.JOBS


def test_what_you_read_is_not_an_instruction():
    import inspect
    import tools
    assert "untrusted.wrap" in inspect.getsource(tools._browse_say)


@pytest.mark.skipif(not _chrome_here(), reason="この環境にはブラウザが無い")
def test_your_login_really_carries_over(tmp_path, monkeypatch):
    """ここがこの機能の存在理由。

    **1周目でログインし、2周目は素通りで入れる**ことを、本物のブラウザと
    本物のCookieで確かめる。ここが通らなければ、サーバー側のブラウザ
    （誰にもログインしていない）と何も変わらない。
    """
    import http.server
    import socketserver
    import threading

    SESSION = "sid=honmono"

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, body: bytes, cookie: str = ""):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            if cookie:
                self.send_header("Set-Cookie", cookie + "; Path=/")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            logged_in = SESSION in (self.headers.get("Cookie") or "")
            if self.path.startswith("/login"):
                self._send("<h1>ログインしました</h1>".encode(), SESSION)
            elif logged_in:
                self._send("<h1>社内ダッシュボード</h1><p>今月の売上 123万円</p>"
                           .encode())
            else:
                self._send("<h1>ログインしてください</h1>".encode())

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    profile = tmp_path / "prof"
    try:
        import aibou_local
        guard = aibou_local.Guard([str(tmp_path)], sites=["127.0.0.1"])
        runner = aibou_local.Runner(guard, False, False, lambda *_: None,
                                    allow_browser=True, profile=str(profile),
                                    headless=True)

        # ① ログインしていない状態では、中身が見えない
        before = runner.do({"kind": "browse",
                            "params": {"url": f"http://127.0.0.1:{port}/"}})
        assert before["ok"] is True, before
        assert "ログインしてください" in before["text"]
        assert "今月の売上" not in before["text"]

        # ② ログインする（本人がやることを、ここでは手順で代用する）
        runner.do({"kind": "browse",
                   "params": {"url": f"http://127.0.0.1:{port}/login"}})

        # ③ **別の呼び出し**で、ログイン済みとして入れる
        after = runner.do({"kind": "browse",
                           "params": {"url": f"http://127.0.0.1:{port}/"}})
        assert after["ok"] is True, after
        assert "社内ダッシュボード" in after["text"]
        assert "今月の売上 123万円" in after["text"]
    finally:
        runner.close_browser()
        srv.shutdown()


@pytest.mark.skipif(not _chrome_here(), reason="この環境にはブラウザが無い")
def test_clicking_in_your_browser_actually_works(tmp_path):
    import http.server
    import socketserver
    import threading

    html = ("<!doctype html><html><head><title>フォーム</title></head><body>"
            "<label for=q>検索</label><input id=q name=q>"
            "<button onclick=\"document.body.innerHTML+='<p>送りました: '"
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
    try:
        import aibou_local
        guard = aibou_local.Guard([str(tmp_path)], sites=["127.0.0.1"])
        runner = aibou_local.Runner(guard, False, False, lambda *_: None,
                                    allow_browser=True,
                                    profile=str(tmp_path / "p"), headless=True)
        got = runner.do({"kind": "browse_act", "params": {
            "url": f"http://127.0.0.1:{port}/",
            "steps": [{"do": "fill", "target": "検索", "value": "東京"},
                      {"do": "click", "target": "検索する"}]}})
        assert got["ok"] is True, got
        assert "送りました: 東京" in got["text"], got["text"]
        assert any("入力しました" in d for d in got["did"])
        assert any("押しました" in d for d in got["did"])
    finally:
        runner.close_browser()
        srv.shutdown()
