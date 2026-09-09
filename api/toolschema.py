"""
api/toolschema.py — 道具の引数を、1か所で定義する。

なぜ要るのか
------------
これまで2つ穴があった。

1. AIへの道具の渡し方が「文章から目印を拾う」方式だった。
   モデルに「返答の1行目に <<<TOOL_CALL>>>{...} と書け」と頼み、その文字列を
   text から探していた。目印を書き忘れる・崩れる・引数のJSONが壊れる、が普通に
   起きる。いまのモデルは function calling を正式に備えているので、そちらを使う。

2. execute_tool が引数を素通しにしていた（handler(params) だけ）。
   型も必須項目も見ていないので、AIが形を間違えても、その場では気づけず
   道具の中で例外になる（そして「ツール実行エラー」という読めない文が返る）。

ここに書いた定義から、
  ・AIへ渡す関数の宣言（ネイティブ function calling 用）
  ・受け取った引数の検証
の両方を作る。定義が1つなので、片方だけ古くなることが起きない。
"""

from typing import Any, Dict, List, Optional, Tuple

# 型の書き方
#   "str"   文字列
#   "int"   整数
#   "bool"  真偽
#   "rows"  表（文字列の二次元配列）
#   "steps" 自動化の手順（オブジェクトの配列）
#   "enum:a,b,c"  決まった選択肢
#
# (型, 必須か, 説明)
Field = Tuple[str, bool, str]

SCHEMAS: Dict[str, Dict[str, Any]] = {
    # ── 仕事の基本 ────────────────────────────────────────────────
    "add_task": {"fields": {
        "title": ("str", True, "タスク名"),
        "content": ("str", False, "補足"),
        "priority": ("enum:high,mid,low", False, "優先度"),
        "due": ("str", False, "期限 YYYY-MM-DD"),
        "project": ("str", False, "グループ名"),
    }},
    "complete_task": {"fields": {
        "title": ("str", True, "完了にするタスクの名前（部分一致でよい）"),
    }},
    "add_agenda": {"fields": {
        "title": ("str", True, "予定の名前"),
        "date": ("str", False, "日付 YYYY-MM-DD"),
        "time": ("str", False, "時刻 HH:MM"),
    }},
    "list_state": {"fields": {}},
    "watch_report": {"fields": {
        "new_only": ("bool", False, "新着だけに絞るか"),
    }},
    "board_add_note": {"fields": {
        "text": ("str", True, "付箋に書く内容"),
        "color": ("enum:yellow,cyan,green,pink,purple,orange", False, "色"),
        "board": ("str", False, "ボード名（省略で最新）"),
    }},
    "remember": {"fields": {
        "content": ("str", True, "覚えておく内容"),
    }},
    "recall": {"fields": {
        "query": ("str", True, "思い出したいキーワード"),
    }},
    "notify": {"fields": {
        "message": ("str", True, "送るメッセージ"),
    }},
    "schedule_add": {"fields": {
        "instruction": ("str", True, "決まった時刻に実行する指示"),
        "time": ("str", False, "時刻 HH:MM（既定 08:00）"),
        "days": ("str", False, '"daily" か "mon,wed,fri" のような曜日'),
    }},
    "schedule_list": {"fields": {}},

    # ── 調べる ────────────────────────────────────────────────────
    "web_search": {"fields": {
        "query": ("str", True, "検索したいこと"),
    }},
    "web_read": {"fields": {
        "url": ("str", True, "読み取るページのURL"),
    }},

    # ── つくる（AIbouの中に保存） ─────────────────────────────────
    "create_document": {"fields": {
        "title": ("str", True, "見出し"),
        "content": ("str", True, "Markdownの本文（完成したものを渡す）"),
    }},
    "create_spreadsheet": {"fields": {
        "title": ("str", True, "表の名前"),
        "rows": ("rows", True, "1行目を見出しにした二次元配列"),
    }},
    "create_slides": {"fields": {
        "topic": ("str", False, "テーマ（渡すと内容も自動生成）"),
        "n": ("int", False, "枚数"),
        "title": ("str", False, "題名（slidesを直接渡すとき）"),
        "slides": ("steps", False, "スライドの配列（直接指定するとき）"),
    }},
    "generate_image": {"fields": {
        "prompt": ("str", True, "どんな絵にするか"),
    }},
    "save_note": {"fields": {
        "content": ("str", True, "本文"),
        "notebook": ("str", False, "保存先のノートブック名"),
        "title": ("str", False, "タイトル"),
    }},

    # ── Google（連携が要る） ──────────────────────────────────────
    "drive_upload": {"fields": {
        "name": ("str", True, "ファイル名"),
        "content": ("str", True, "中身"),
        "mime": ("str", False, "種類（既定 text/plain）"),
    }},
    "google_doc": {"fields": {
        "title": ("str", True, "見出し"),
        "content": ("str", True, "本文"),
    }},
    "google_sheet": {"fields": {
        "title": ("str", True, "表の名前"),
        "rows": ("rows", True, "1行目を見出しにした二次元配列"),
    }},
    "create_google_slides": {"fields": {
        "topic": ("str", False, "テーマ"),
        "title": ("str", False, "題名"),
        "slides": ("steps", False, "スライドの配列"),
    }},
    "calendar_add": {"fields": {
        "title": ("str", True, "予定の名前"),
        "date": ("str", True, "日付 YYYY-MM-DD"),
        "time": ("str", False, "時刻 HH:MM（省略で終日）"),
    }},
    "calendar_list": {"fields": {
        "days": ("int", False, "何日先まで見るか"),
    }},

    # ── メール ────────────────────────────────────────────────────
    "send_email": {"fields": {
        "to": ("str", True, "宛先のメールアドレス"),
        "subject": ("str", False, "件名"),
        "body": ("str", True, "本文"),
    }},
    "email_inbox": {"fields": {
        "limit": ("int", False, "何件見るか"),
    }},

    # ── そのほか ──────────────────────────────────────────────────
    "notion_add": {"fields": {
        "title": ("str", True, "メモの見出し"),
        "content": ("str", False, "本文"),
    }},
    "create_automation": {"fields": {
        "name": ("str", True, "フロー名"),
        "steps": ("steps", True,
                  '手順の配列。各手順は {"type": "ai_generate|notify|create_task", '
                  '"params": {...}}'),
    }},
    "run_automation": {"fields": {
        "name": ("str", True, "実行するフロー名"),
        "input": ("str", False, "任意の入力"),
    }},
    "create_mission": {"fields": {
        "objective": ("str", True, "達成したいゴール"),
    }},
    "enqueue_income": {"fields": {
        "theme": ("str", True, "生成テーマ"),
    }},
    "income_status": {"fields": {}},
}


# ── AIへ渡す関数の宣言 ───────────────────────────────────────────────
_JSON_TYPE = {
    "str": {"type": "string"},
    "int": {"type": "integer"},
    "bool": {"type": "boolean"},
    "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
    "steps": {"type": "array", "items": {"type": "object"}},
}


def _prop(spec: Field) -> dict:
    kind, _req, desc = spec
    if kind.startswith("enum:"):
        out = {"type": "string", "enum": kind[5:].split(",")}
    else:
        out = dict(_JSON_TYPE.get(kind, {"type": "string"}))
    out["description"] = desc
    return out


def declaration(name: str, description: str) -> Optional[dict]:
    """1つの道具を、モデルに渡せる関数の宣言にする。

    Gemini も OpenAI も、この形（OpenAPI風のJSON Schema）を受け取れる。
    """
    s = SCHEMAS.get(name)
    if s is None:
        return None
    fields: Dict[str, Field] = s["fields"]
    props = {k: _prop(v) for k, v in fields.items()}
    required = [k for k, v in fields.items() if v[1]]
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": props,
                       "required": required},
    }


def declarations(names, docs: Dict[str, str]) -> List[dict]:
    """使う道具ぶんの宣言をまとめて作る。"""
    out = []
    for n in names or []:
        d = declaration(n, (docs.get(n) or n))
        if d:
            out.append(d)
    return out


# ── 受け取った引数の検証 ─────────────────────────────────────────────
def _coerce(kind: str, value: Any) -> Tuple[Any, Optional[str]]:
    """AIが少し違う形で渡してきたものを、直せる範囲で直す。

    直せない物は理由を返す。ここで黙って通すと、道具の中で例外になって
    「ツール実行エラー」という読めない文が利用者に届く。
    """
    if kind == "str":
        if isinstance(value, (str, int, float)):
            return str(value), None
        return None, "文字列で渡してください"
    if kind == "int":
        if isinstance(value, bool):
            return None, "数値で渡してください"
        if isinstance(value, int):
            return value, None
        try:
            return int(str(value).strip()), None
        except Exception:
            return None, "数値で渡してください"
    if kind == "bool":
        if isinstance(value, bool):
            return value, None
        s = str(value).strip().lower()
        if s in ("true", "1", "yes"):
            return True, None
        if s in ("false", "0", "no", ""):
            return False, None
        return None, "true か false で渡してください"
    if kind == "rows":
        if not isinstance(value, list):
            return None, "表は二次元の配列で渡してください"
        rows = []
        for r in value:
            if isinstance(r, list):
                rows.append([str(c) for c in r])
            else:
                rows.append([str(r)])          # 1行1列とみなす
        return rows, None
    if kind == "steps":
        if not isinstance(value, list):
            return None, "配列で渡してください"
        return [x for x in value if isinstance(x, dict)], None
    if kind.startswith("enum:"):
        allowed = kind[5:].split(",")
        s = str(value).strip()
        if s in allowed:
            return s, None
        return None, f"次のどれかで渡してください（{' / '.join(allowed)}）"
    return value, None


def validate(name: str, params: Any) -> Tuple[Optional[dict], str]:
    """引数を検証して (整えた引数, エラー文) を返す。

    定義の無い道具は素通し（新しい道具を足したときに、検証が無いだけで
    使えなくなるのを避ける）。
    """
    s = SCHEMAS.get(name)
    if s is None:
        return (params if isinstance(params, dict) else {}), ""
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return None, f"{name} の引数は名前付きで渡してください"

    fields: Dict[str, Field] = s["fields"]
    out: Dict[str, Any] = {}
    problems: List[str] = []

    for key, spec in fields.items():
        kind, required, desc = spec
        # 「鍵ごと無い」だけを、こちらの落ち度として見る。
        # 「あるけれど空」は道具に通す。道具のほうが場に合った言い方ができる
        #（「Googleドキュメントの内容が空です」のように）。こちらで先に
        # 一般的な文言で止めると、そのぶん案内が下手になる。
        if key not in params or params[key] is None:
            if required:
                problems.append(f"{key}（{desc}）が足りません")
            continue
        if params[key] == "":
            out[key] = ""
            continue
        fixed, err = _coerce(kind, params[key])
        if err:
            problems.append(f"{key}（{desc}）は{err}")
            continue
        out[key] = fixed

    # 定義に無い引数は落とす。AIが余分な物を付けてくることがあり、
    # そのまま渡すと道具が想定外の分岐に入る。
    if problems:
        return None, "、".join(problems)
    return out, ""
