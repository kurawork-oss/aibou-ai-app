"""
api/capabilities.py — 「何ができるか」の台帳。

ここが1か所で3つを決める。
  ① パック    … 使う機能のかたまりを、まとめて入り切りする
  ② # コマンド … 会話でAIに考えさせず、道具へ直行する近道
  ③ 道具の説明 … AIに毎回送る説明を、使う物だけに絞る

なぜ絞るのか
------------
道具の説明は毎回のリクエストに丸ごと乗っていて、全部で約3,900文字あった。
送る量が増えるほど返事は遅くなり、選択肢が多いほど道具の選び間違いも増える
（「ドライブに作って」で別の道具が選ばれたのが、まさにこれ）。
見た目の整理ではなく、速さと正確さのための仕組み。

決めさせない工夫
----------------
30個のスイッチを並べたら、それはそれで面倒なだけ。だから2段構えにする。
  ・繋いでいない連携の道具は、勝手に消える（決めなくていい。ここで8割片付く）
  ・残りは5つのパックでまとめて切り替える

# コマンドの位置づけ
-------------------
`#画像 猫の絵` は、AIに「どの道具を使うか」を考えさせずに直行する。速くて確実。
`猫の絵を描いて` は、AIが選ぶ。融通は利くが一手多い。
**どちらでも同じことができる**のが大事で、# を覚えないと使えないなら負け。
"""

from typing import Dict, List, Optional

# ── パック（まとめて入り切りする単位） ───────────────────────────────
PACKS: Dict[str, dict] = {
    "core": {
        "label": "仕事の基本", "hint": "タスク・予定・メール・見張り・記憶",
        "default": True,
        # ここを切ると相棒がほぼ何もできなくなるので、切らせない
        "always": True,
    },
    "make": {"label": "つくる", "hint": "画像・スライド・資料・ドキュメント",
             "default": True},
    "share": {"label": "発信する", "hint": "SNS・LP・記事・ニュースレター",
              "default": False},
    "dev": {"label": "開発", "hint": "コード・GitHub", "default": False},
    "income": {"label": "副業", "hint": "収益の自動化", "default": False,
               "owner_only": True},
}

PACK_ORDER = ["core", "make", "share", "dev", "income"]


# ── できること1つぶん ────────────────────────────────────────────────
# cmd   … # のあとに打つ名前
# yomi  … 読み（かな）と英語。日本語入力はかなを通るので、これが無いと
#          「#がぞう」と打った人が「画像」を見つけられない
# tool  … 直行できる道具（tools._DISPATCH の名前）。無い物は画面を開くだけ
# view  … 開く画面（管理タブの中身、または専用画面）
# needs … これが繋がっていないと使えない（oauth.PROVIDERS の名前 or 鍵の名前）
# arg   … # のあとに続けて書く物。説明に出す
CAPABILITIES: List[dict] = [
    # 仕事の基本
    {"cmd": "タスク", "yomi": "たすく task", "label": "タスクを追加", "pack": "core",
     "tool": "add_task", "arg": "やること", "icon": "✓"},
    {"cmd": "予定", "yomi": "よてい yotei schedule", "label": "予定を追加", "pack": "core",
     "tool": "add_agenda", "arg": "いつ・何を", "icon": "📅"},
    {"cmd": "状況", "yomi": "じょうきょう status", "label": "いまの状況をまとめる", "pack": "core",
     "tool": "watch_report", "arg": "", "icon": "👀"},
    {"cmd": "メール", "yomi": "めーる mail", "label": "受信メールを見る", "pack": "core",
     "tool": "email_inbox", "arg": "件数", "icon": "✉"},
    {"cmd": "メール送信", "yomi": "めーるそうしん mail send", "label": "メールを送る", "pack": "core",
     "tool": "send_email", "arg": "宛先と用件", "icon": "📤"},
    {"cmd": "検索", "yomi": "けんさく search", "label": "Webを検索する", "pack": "core",
     "tool": "web_search", "arg": "調べたいこと", "icon": "🔍"},
    {"cmd": "読む", "yomi": "よむ read url", "label": "ページを読む", "pack": "core",
     "tool": "web_read", "arg": "URL", "icon": "📖"},
    {"cmd": "覚えて", "yomi": "おぼえて remember", "label": "覚えておく", "pack": "core",
     "tool": "remember", "arg": "覚える内容", "icon": "🧠"},
    {"cmd": "思い出して", "yomi": "おもいだして recall", "label": "思い出す", "pack": "core",
     "tool": "recall", "arg": "キーワード", "icon": "💭"},
    {"cmd": "通知", "yomi": "つうち notify", "label": "通知を送る", "pack": "core",
     "tool": "notify", "arg": "メッセージ", "icon": "🔔"},
    {"cmd": "定期実行", "yomi": "ていきじっこう schedule", "label": "決まった時刻に実行する", "pack": "core",
     "tool": "schedule_add", "arg": "何を・何時に", "icon": "⏰"},
    {"cmd": "付箋", "yomi": "ふせん sticky note", "label": "ボードに付箋を貼る", "pack": "core",
     "tool": "board_add_note", "arg": "書く内容", "view": "board", "icon": "🗒"},

    # つくる
    {"cmd": "画像", "yomi": "がぞう image picture", "label": "画像をつくる", "pack": "make",
     "tool": "generate_image", "arg": "どんな絵か", "icon": "🖼"},
    {"cmd": "スライド", "yomi": "すらいど slide", "label": "スライドをつくる", "pack": "make",
     "tool": "create_slides", "arg": "テーマ", "icon": "📊"},
    {"cmd": "資料", "yomi": "しりょう document doc", "label": "ドキュメントをつくる", "pack": "make",
     "tool": "create_document", "arg": "見出し", "icon": "📄"},
    {"cmd": "表", "yomi": "ひょう table sheet", "label": "表をつくる", "pack": "make",
     "tool": "create_spreadsheet", "arg": "表の名前", "icon": "🧮"},
    {"cmd": "ノート", "yomi": "のーと note", "label": "ノートに保存する", "pack": "make",
     "tool": "save_note", "arg": "書く内容", "icon": "📓"},

    # Google（繋いでいなければ勝手に消える）
    {"cmd": "ドライブ", "yomi": "どらいぶ drive", "label": "ドライブにファイルを作る", "pack": "make",
     "tool": "drive_upload", "arg": "ファイル名と中身", "needs": "google", "icon": "📁"},
    {"cmd": "Gドキュメント", "yomi": "gどきゅめんと google doc", "label": "Googleドキュメントを作る", "pack": "make",
     "tool": "google_doc", "arg": "見出し", "needs": "google", "icon": "📝"},
    {"cmd": "Gスプレッドシート", "yomi": "gすぷれっどしーと google sheet", "label": "Googleスプレッドシートを作る", "pack": "make",
     "tool": "google_sheet", "arg": "表の名前", "needs": "google", "icon": "📗"},
    {"cmd": "Gスライド", "yomi": "gすらいど google slide", "label": "Googleスライドを作る", "pack": "make",
     "tool": "create_google_slides", "arg": "テーマ", "needs": "google", "icon": "📽"},
    {"cmd": "カレンダー登録", "yomi": "かれんだーとうろく calendar add", "label": "Googleカレンダーに入れる", "pack": "core",
     "tool": "calendar_add", "arg": "いつ・何を", "needs": "google", "icon": "🗓"},
    {"cmd": "カレンダー", "yomi": "かれんだー calendar", "label": "Googleカレンダーを見る", "pack": "core",
     "tool": "calendar_list", "arg": "日数", "needs": "google", "icon": "📆"},

    # 発信する
    {"cmd": "Notion", "yomi": "のーしょん notion", "label": "Notionに書き足す", "pack": "share",
     "tool": "notion_add", "arg": "見出し", "needs": "notion", "icon": "🗃"},

    # 自動化・開発・副業
    {"cmd": "自動化", "yomi": "じどうか automation", "label": "自動化フローを作る", "pack": "dev",
     "tool": "create_automation", "arg": "フロー名", "icon": "⚡"},
    {"cmd": "自動化実行", "yomi": "じどうかじっこう run automation", "label": "自動化フローを動かす", "pack": "dev",
     "tool": "run_automation", "arg": "フロー名", "icon": "▶"},
    {"cmd": "ゴール", "yomi": "ごーる goal mission", "label": "ゴールを分解して進める", "pack": "dev",
     "tool": "create_mission", "arg": "達成したいこと", "icon": "🎯"},
    {"cmd": "副業", "yomi": "ふくぎょう income", "label": "副業ジョブを積む", "pack": "income",
     "tool": "enqueue_income", "arg": "テーマ", "icon": "💰"},
    {"cmd": "副業状況", "yomi": "ふくぎょうじょうきょう income status", "label": "副業の状況を見る", "pack": "income",
     "tool": "income_status", "arg": "", "icon": "📈"},

    # 画面を開くだけ（道具ではない）。
    # "view" は画面側の View 名をそのまま書く。ここが実在しない名前だと
    # 押しても何も起きないが、エラーにもならないので静かに壊れる。
    # webapp/tests/shell.spec.ts で実在するか突き合わせている。
    {"cmd": "ボード", "yomi": "ぼーど board whiteboard", "label": "ホワイトボードを開く", "pack": "core",
     "view": "board", "arg": "", "icon": "🧩"},
    {"cmd": "コード", "yomi": "こーど code", "label": "コードの作業場を開く", "pack": "dev",
     "view": "code", "arg": "", "icon": "⌨"},
    {"cmd": "ファイル", "yomi": "ふぁいる file", "label": "作った物を見る", "pack": "core",
     "view": "archive", "arg": "", "icon": "🗂"},
    {"cmd": "録音", "yomi": "ろくおん record capture", "label": "録音・文字起こし", "pack": "make",
     "view": "capture", "arg": "", "icon": "🎙"},
    # 名前が「資料」だと、資料をつくる側（create_document）とよみが同じに
    # なる。#しり まで打った時点で2つに割れて、どちらも出せなくなっていた。
    # やることは別物（作る／入れた物から答える）なので、名前で分ける。
    {"cmd": "保管庫", "yomi": "ほかんこ vault library", "label": "入れた資料から答える", "pack": "make",
     "view": "vault", "arg": "", "icon": "📚"},
]

# 説明だけあって # を出さない道具（AIには渡すが、直行の入口は作らない）。
# list_state は watch_report と役目が重なるので、人には1つだけ見せる。
_HIDDEN_TOOLS = {"list_state", "schedule_list", "complete_task"}


# ── どのパックが有効か ───────────────────────────────────────────────
_STORE_KEY = "FEATURE_PACKS"


def enabled_packs(is_owner: bool = True) -> List[str]:
    """有効なパック。保存が無ければ既定。"""
    import keychain
    raw = (keychain.get_key(_STORE_KEY) or "").strip()
    if raw:
        picked = {p.strip() for p in raw.split(",") if p.strip()}
    else:
        picked = {k for k, v in PACKS.items() if v.get("default")}
    out = []
    for k in PACK_ORDER:
        p = PACKS[k]
        if p.get("owner_only") and not is_owner:
            continue
        if p.get("always") or k in picked:
            out.append(k)
    return out


def set_packs(names: List[str]) -> dict:
    """有効なパックを保存する。常時ONの物は勝手に足す。"""
    import keychain
    picked = {n for n in (names or []) if n in PACKS}
    picked |= {k for k, v in PACKS.items() if v.get("always")}
    res = keychain.set_key(_STORE_KEY, ",".join(k for k in PACK_ORDER if k in picked))
    if res.get("error"):
        return res
    return {"ok": True, "packs": [k for k in PACK_ORDER if k in picked]}


def _connected(name: str) -> bool:
    """その連携が使える状態か。判断できないときは「使える」に倒す。

    ここで誤って False にすると、繋いでいるのに道具が消える。
    消えるほうが気づきにくいので、迷ったら残す。
    """
    try:
        import oauth
        if name in oauth.PROVIDERS:
            return oauth.connected(name)
    except Exception:
        return True
    try:
        import keychain
        return bool((keychain.get_key(name) or "").strip())
    except Exception:
        return True


def available(is_owner: bool = True) -> List[dict]:
    """いま使えること。パックで有効かつ、必要な連携が繋がっている物。"""
    packs = set(enabled_packs(is_owner))
    out = []
    for c in CAPABILITIES:
        if c["pack"] not in packs:
            continue
        need = c.get("needs")
        if need and not _connected(need):
            continue
        out.append(c)
    return out


def enabled_tools(is_owner: bool = True) -> set:
    """AIに渡してよい道具の名前。

    絞るのはパックだけで、**連携の有無では絞らない**。ここは # の一覧とは
    わざと違えてある。

    理由: 繋いでいないからと道具ごと隠すと、「ドライブに作って」と頼まれた
    AIが、その道具を知らないまま一番近い別の道具（AIbou内に保存するだけ）を
    選び、「作成しました」と答える。以前これが起きた。
    道具を残しておけば、AIは正しくそれを選び、「Google未接続です」と正直に
    返せる。**嘘をつかないほうを取る。**

    # の一覧のほうは、押しても必ず失敗する近道を並べても仕方がないので、
    繋いでいない物は出さない（available を使う）。

    表に出さない道具（_HIDDEN_TOOLS）も、パックが有効なら渡す。
    人に見せる入口を作らないだけで、AIには使わせたいものがある。
    """
    packs = set(enabled_packs(is_owner))
    names = {c["tool"] for c in CAPABILITIES
             if c.get("tool") and c["pack"] in packs}
    if "core" in packs:
        names |= _HIDDEN_TOOLS
    return names


def tools_doc(is_owner: bool = True) -> str:
    """AIに渡す道具の説明（使う物だけ）。"""
    import tools
    return tools.tools_doc(enabled_tools(is_owner))


# ── # コマンドの解釈 ─────────────────────────────────────────────────
def find(cmd: str, is_owner: bool = True) -> Optional[dict]:
    """コマンド名から、できることを引く。

    前方一致とよみ（かな・英語）でも引ける。日本語入力はかなを通るので、
    漢字の前方一致だけだと「#がぞう」と打った人が「画像」を見つけられない。
    候補が1つに絞れないときは None（勝手に決めない）。
    """
    name = (cmd or "").strip().lstrip("#＃")
    if not name:
        return None
    items = available(is_owner)
    low = name.lower()
    for c in items:
        if c["cmd"] == name:
            return c
    for pick in (lambda c: c["cmd"].lower().startswith(low),
                 lambda c: (c.get("yomi") or "").lower().startswith(low),
                 lambda c: low in (c.get("yomi") or "").lower()):
        hits = [c for c in items if pick(c)]
        if len(hits) == 1:
            return hits[0]
        if hits:
            return None       # 絞れないなら決めない（取り違えるより聞く）
    return None


def parse(text: str, is_owner: bool = True) -> Optional[dict]:
    """「#画像 猫の絵」を {capability, rest} に分ける。# で始まらなければ None。

    見つからないコマンドでも None を返す。そのときは、ただの文として
    AIに渡ればよい（打ち間違いで会話が止まらないように）。
    """
    t = (text or "").strip()
    if not t or t[0] not in "#＃":
        return None
    head, _, rest = t[1:].partition(" ")
    # 全角スペースで区切る人もいる
    if not rest and "　" in head:
        head, _, rest = head.partition("　")
    cap = find(head, is_owner)
    if not cap:
        return None
    return {"capability": cap, "rest": rest.strip()}


def status(is_owner: bool = True) -> dict:
    """画面用。パックの状態と、いま使えることの一覧。"""
    on = set(enabled_packs(is_owner))
    packs = []
    for k in PACK_ORDER:
        p = PACKS[k]
        if p.get("owner_only") and not is_owner:
            continue
        packs.append({
            "key": k, "label": p["label"], "hint": p["hint"],
            "enabled": k in on, "always": bool(p.get("always")),
        })
    return {
        "packs": packs,
        "commands": [
            {"cmd": c["cmd"], "label": c["label"], "arg": c.get("arg", ""),
             "icon": c.get("icon", ""), "pack": c["pack"], "yomi": c.get("yomi", ""),
             "view": c.get("view", ""), "direct": bool(c.get("tool"))}
            for c in available(is_owner)
        ],
    }
