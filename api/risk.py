"""
api/risk.py — 道具の危なさを4段階で持つ。

これまで
--------
agent.py に SENSITIVE_TOOLS という平たい集合が1つあった。

    SENSITIVE_TOOLS = {"send_email", "notify", "run_automation", "enqueue_income"}

これだと2つ困る。

1. **メール送信とWeb検索が同じ扱い。** 承認モードを切ると、送信も確認なしで
   通る。取り返しがつかない物と、ただ読むだけの物を、同じ札で括っている。
2. **承認モードを入り切りする以外の調整ができない。** 「作るのは任せたいが
   送るのは必ず聞いてほしい」という、いちばん普通の要望が表現できない。

段階
----
0 取得のみ      … 読むだけ。何も変わらない（検索・一覧・思い出す）
1 自分の中を変更 … このアプリの中だけが変わる（タスク追加・付箋・メモ）
2 外を変更      … 外のサービスに残る（カレンダー・ドライブ・Notion）
3 取り返せない  … 送る・投稿する・お金が動く（メール送信・通知・副業投入）

既定の振る舞い
--------------
0 と 1 は確認しない。
2 は承認モードのときだけ確認する。
**3 は承認モードに関わらず必ず確認する。**

3を必ず確認にしているのがこの変更の芯。「承認モードを切っていたから
黙ってメールが飛んだ」を、設定の組み合わせで起こせないようにする。
"""

from typing import Dict

# 0: 取得のみ / 1: 自分の中 / 2: 外を変更 / 3: 取り返せない
LEVELS: Dict[str, int] = {
    # ── 0 取得のみ ────────────────────────────────────────────────
    "list_state": 0,
    "watch_report": 0,
    "schedule_list": 0,
    "recall": 0,
    "web_search": 0,
    "web_read": 0,
    "email_inbox": 0,
    "calendar_list": 0,
    "income_status": 0,

    # ── 1 このアプリの中だけが変わる ──────────────────────────────
    "add_task": 1,
    "complete_task": 1,
    "add_agenda": 1,
    "board_add_note": 1,
    "remember": 1,
    "save_note": 1,
    "create_document": 1,
    "create_spreadsheet": 1,
    "create_slides": 1,
    "generate_image": 1,
    # 図は描いて見せるだけ。どこにも残らないので、いちばん軽い。
    "draw_diagram": 0,
    "schedule_add": 1,
    "create_automation": 1,
    "create_mission": 1,

    # ── 2 外のサービスに残る ──────────────────────────────────────
    "drive_upload": 2,
    "google_doc": 2,
    "google_sheet": 2,
    "create_google_slides": 2,
    "calendar_add": 2,
    "notion_add": 2,

    # ── 3 取り返せない（必ず確認） ────────────────────────────────
    "send_email": 3,
    "notify": 3,
    "enqueue_income": 3,
    "run_automation": 3,
}

# 段階の説明（画面に出す）
LABELS: Dict[int, str] = {
    0: "読むだけ",
    1: "AIbouの中が変わる",
    2: "外のサービスに残る",
    3: "取り返せない",
}

# 確認のときに添える一言（何が起きるのかを具体的に）
WHY: Dict[str, str] = {
    "send_email": "送ったメールは取り消せません。",
    "notify": "LINEやSlackに実際に届きます。",
    "enqueue_income": "副業の処理が動き出します。",
    "run_automation": "フローの中身がまとめて実行されます。",
}

# 段階を書き忘れた道具の扱い。
#
# 「たぶん安全」に倒すと、新しい道具を足した人が段階を書き忘れただけで、
# それが黙って実行される。書き忘れは必ず起きるので、いちばん重い扱いにして
# 必ず確認へ回す。害の無い道具なら確認が1回余分に出るだけで済むが、
# 逆だと取り返しがつかない。
#
# なお全部の道具に段階が付いていることはテストで縛ってあるので、
# ここが効くのは「足したのに書き忘れた」瞬間だけ。
UNKNOWN = 3


def level(tool: str) -> int:
    return LEVELS.get((tool or "").strip(), UNKNOWN)


def needs_confirmation(tool: str, approval_mode: bool) -> bool:
    """実行の前に人に聞くべきか。

    approval_mode は「確認しながら進める」設定。切っていても、
    段階3（取り返せない）は必ず聞く。設定の組み合わせで
    「黙ってメールが飛ぶ」が起きないようにする。
    """
    lv = level(tool)
    if lv >= 3:
        return True
    if lv >= 2:
        return bool(approval_mode)
    return False


def describe(tool: str) -> dict:
    """画面に出すための1件ぶん。"""
    lv = level(tool)
    return {
        "tool": tool,
        "level": lv,
        "label": LABELS.get(lv, LABELS[UNKNOWN]),
        "always_confirm": lv >= 3,
        "why": WHY.get(tool, ""),
    }


def table() -> list:
    """全部の道具の段階（設定画面と、説明の突き合わせに使う）。"""
    return [describe(t) for t in sorted(LEVELS)]
