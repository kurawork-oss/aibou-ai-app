"""
recipes.py — 決まった手順を保存して、毎回同じに流す（Playwright の役割）。

なぜ要るか
----------
「毎朝、社内ポータルで今日のケースを開いて、担当で絞って、一覧を読む」は、
毎回AIに画面を見せて判断させる仕事ではない。やることは決まっている。
それをAIに毎回やらせると、

  ・毎回ちがう押し方をする（昨日押せたボタンを、今日は別の名前で探す）
  ・遅い（1手ごとに考える）

一度うまくいった手順に名前を付けて残し、次からは**その通りに**流す。
役割分担（OpenCLI＝AIが画面を見ながら判断する／Playwright＝決まった手順を
毎回同じに流す）の、Playwright 側がこれ。

決めていること
--------------
  ・手元で流すときは、相棒の**専用ブラウザ（Playwright）だけ**を使う。
    あなたのChrome（OpenCLI）では流さない——開いているタブの状態に左右
    されず、毎回同じ所から始めるため
  ・1手でも失敗したら**そこで止める**。続きは押さない（途中がずれたまま
    押し進めると、違う物を送りうる）
  ・変わる所だけ `{名前}` で空けておける（例: 検索欄に `{顧客名}`）。
    ホスト名には使えない（どの台で開くかを、保存の時点で決められなくなる）
  ・**パスワードは手順に入れない。** 入力欄の名前がパスワード・暗証番号・
    認証コードらしい物は、保存の時点で断る。鍵らしい文字列も断る。
    手順はクラウド（あなたのDB）に残るので、そこにログイン情報を置かない。
    ログインは本人が手元で一度だけ通す（相棒の `--login`）
  ・危なさは中身と場所で決まる。押す・打ち込む手順があれば、手元では
    あなたとして押すので段階3（browser_router が決める）
"""

from __future__ import annotations

import json
import re
import time
import uuid
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote, urlparse

import config
import memstore
import secrets_guard

TABLE = "browser_recipes"

MAX_RECIPES = 50
MAX_STEPS = 20
MAX_NAME = 40
MAX_DESC = 200
MAX_TEXT = 500          # 1手の target / value
MAX_VALUE = 200         # 流すときに入れる値

ACTIONS = ("goto", "click", "fill", "select", "press", "wait")
#: 押す・打ち込む手（これが1つでもあれば「あなたとして操作する」手順）
TOUCH = ("click", "fill", "select", "press")

#: `{顧客名}` のような空け所
_PARAM = re.compile(r"\{([^{}\s]{1,24})\}")

#: 鍵を入れる欄に見える名前。値が何であれ、ここへ打ち込む手順は作らない。
_SECRET_FIELD = re.compile(
    r"(パスワード|ぱすわーど|password|passwd|passcode|パスコード|暗証|"
    r"(?<![a-z])pin(?![a-z])|ワンタイム|one.?time|(?<![a-z])otp(?![a-z])|"
    r"認証コード|確認コード|セキュリティコード|security.?code|"
    r"カード番号|card.?number|(?<![a-z])cv[vc]2?(?![a-z])|秘密の質問|"
    r"secret|token|トークン)", re.I)

_mem = memstore.TenantList()


def _now() -> float:
    return time.time()


# ── 形を確かめる ────────────────────────────────────────────────────

def host_of(url: str) -> str:
    """保存してよいURLなら、そのホスト名。駄目なら空文字。"""
    try:
        p = urlparse((url or "").strip())
    except Exception:
        return ""
    if (p.scheme or "").lower() not in ("http", "https"):
        return ""
    host = (p.hostname or "").lower()
    # ホスト名に空け所は使えない（どの台で開くかが決まらなくなる）
    if not host or "{" in (p.netloc or "") or "}" in (p.netloc or ""):
        return ""
    return host


def secret_field(target: str) -> bool:
    """鍵を入れる欄に見えるか（手元の相棒も同じ線で断る）。"""
    return bool(_SECRET_FIELD.search(target or ""))


def clean_steps(steps) -> Tuple[List[dict], str]:
    """保存してよい形に整える。(整えた手順, 断る理由)。"""
    if isinstance(steps, str):
        try:
            steps = json.loads(steps)
        except Exception:
            return [], "手順は配列で渡してください"
    if isinstance(steps, dict):
        steps = [steps]
    if not isinstance(steps, list) or not steps:
        return [], "手順が空です"
    if len(steps) > MAX_STEPS:
        return [], f"手順は{MAX_STEPS}手までです（いま{len(steps)}手）"
    out: List[dict] = []
    for i, s in enumerate(steps, 1):
        if not isinstance(s, dict):
            return [], f"{i}手目の形が違います"
        kind = str(s.get("do") or "").strip().lower()
        if kind not in ACTIONS:
            return [], f"{i}手目の「{kind or '空'}」は使えません（{' / '.join(ACTIONS)}）"
        target = str(s.get("target") or "").strip()[:MAX_TEXT]
        value = str(s.get("value") if s.get("value") is not None else "")[:MAX_TEXT]
        if kind in ("click", "fill", "select") and not target:
            return [], f"{i}手目: どこを触るのか（target）がありません"
        if kind == "goto" and not (value or target):
            return [], f"{i}手目: どこへ移るのか（value）がありません"
        if kind == "fill" and secret_field(target):
            return [], (f"{i}手目: 「{target}」はパスワードなど鍵を入れる欄に見えます。"
                        "手順には入れません。ログインは手元の相棒で一度だけ通してください"
                        "（--login）")
        for text in (target, value):
            why = secrets_guard.why(text)
            if why:
                return [], f"{i}手目: {why}。手順には入れません"
        out.append({"do": kind, "target": target, "value": value})
    return out, ""


def params_of(url: str, steps: List[dict]) -> List[str]:
    """空け所の名前（出てきた順・重複なし）。"""
    seen: List[str] = []
    texts = [url] + [t for s in steps for t in (s.get("target", ""), s.get("value", ""))]
    for t in texts:
        for name in _PARAM.findall(t or ""):
            if name not in seen:
                seen.append(name)
    return seen


def touches(recipe: dict) -> bool:
    """押す・打ち込む手があるか（あれば、手元ではあなたとして操作する）。"""
    return any((s or {}).get("do") in TOUCH for s in (recipe or {}).get("steps") or [])


# ── 置き場 ──────────────────────────────────────────────────────────

def _rows() -> List[dict]:
    c = config.get_supabase()
    if c:
        try:
            rows = c.table(TABLE).select("*").order("updated_at", desc=True) \
                    .limit(MAX_RECIPES).execute().data
            if rows is not None:
                return [_parse(r) for r in rows]
        except Exception:
            pass
    return sorted((_parse(r) for r in _mem),
                  key=lambda r: -float(r.get("updated_at") or 0))


def _parse(row: dict) -> dict:
    """DBから来た行の jsonb は、文字列で来ることがある。"""
    r = dict(row or {})
    for key in ("steps", "params"):
        if isinstance(r.get(key), str):
            try:
                r[key] = json.loads(r[key])
            except Exception:
                r[key] = []
    return r


def _put(row: dict, replace: bool) -> str:
    """どこに入れたかを返す（"db" / "memory"）。"""
    for i in range(len(_mem)):
        if (_mem[i] or {}).get("id") == row["id"]:
            del _mem[i]
            break
    _mem.append(row)
    c = config.get_supabase()
    if c:
        try:
            if replace:
                c.table(TABLE).update(row).eq("id", row["id"]).execute()
            else:
                c.table(TABLE).insert(row).execute()
            return "db"
        except Exception:
            pass
    return "memory"


def _patch(recipe_id: str, patch: dict) -> None:
    for i in range(len(_mem)):
        if (_mem[i] or {}).get("id") == recipe_id:
            _mem[i] = {**_mem[i], **patch}
            break
    c = config.get_supabase()
    if c:
        try:
            c.table(TABLE).update(patch).eq("id", recipe_id).execute()
        except Exception:
            pass


# ── 読む・書く ──────────────────────────────────────────────────────

def list_all() -> List[dict]:
    return _rows()


def get(key: str) -> Optional[dict]:
    """IDか名前で1つ引く。名前は人が言う物なので、少しの揺れは許す。"""
    k = (key or "").strip()
    if not k:
        return None
    rows = _rows()
    for r in rows:
        if r.get("id") == k or r.get("name") == k:
            return r
    low = k.casefold()
    for r in rows:
        if (r.get("name") or "").casefold() == low:
            return r
    # 「朝のケース確認を流して」→ 名前が「朝のケース確認」。片方がもう片方を
    # 含むとき、**1つに決まるときだけ**それとみなす（2つ当たったら決めない）
    hits = [r for r in rows
            if low in (r.get("name") or "").casefold()
            or (r.get("name") or "").casefold() in low]
    return hits[0] if len(hits) == 1 else None


def save(name: str, url: str, steps, description: str = "", device: str = "") -> dict:
    """名前を付けて残す。同じ名前があれば、それを書き換える。"""
    name = (name or "").strip().strip("「」『』\"'")[:MAX_NAME]
    if not name:
        return {"ok": False, "error": "名前を付けてください（あとで「○○を流して」と呼ぶ名前）"}
    url = (url or "").strip()
    if not host_of(url):
        return {"ok": False,
                "error": "始めるページは http(s) のURLにしてください（ホスト名に {…} は使えません）"}
    why = secrets_guard.why(url)
    if why:
        return {"ok": False, "error": f"URLに{why}。手順には入れません"}
    clean, err = clean_steps(steps)
    if err:
        return {"ok": False, "error": err}

    existing = next((r for r in _rows() if r.get("name") == name), None)
    if existing is None and len(_rows()) >= MAX_RECIPES:
        return {"ok": False, "error": f"手順は{MAX_RECIPES}個までです。使っていない物を消してください"}
    now = _now()
    row = {
        "id": existing["id"] if existing else uuid.uuid4().hex,
        "name": name,
        "description": (description or "").strip()[:MAX_DESC],
        "url": url,
        "steps": clean,
        "params": params_of(url, clean),
        "device": (device or "").strip()[:40],
        "created_at": float((existing or {}).get("created_at") or now),
        "updated_at": now,
        "last_run_at": (existing or {}).get("last_run_at"),
        "last_result": (existing or {}).get("last_result") or "",
    }
    stored = _put(row, existing is not None)
    return {"ok": True, "recipe": row, "stored": stored, "replaced": existing is not None}


def delete(key: str) -> dict:
    r = get(key)
    if not r:
        return {"ok": False, "error": f"「{key}」という手順はありません"}
    for i in range(len(_mem)):
        if (_mem[i] or {}).get("id") == r["id"]:
            del _mem[i]
            break
    c = config.get_supabase()
    if c:
        try:
            c.table(TABLE).delete().eq("id", r["id"]).execute()
        except Exception:
            pass
    return {"ok": True, "name": r["name"]}


def mark_run(recipe_id: str, ok: bool, summary: str) -> None:
    """最後に流した結果を残す（一覧に出す。うまく流れなくなった手順に気づくため）。"""
    _patch(recipe_id, {"last_run_at": _now(),
                       "last_result": (("✓ " if ok else "✗ ") + (summary or ""))[:200]})


# ── 流す形にする ────────────────────────────────────────────────────

def materialize(recipe: dict, values: Optional[Dict[str, str]] = None) -> dict:
    """空け所に値を入れて、流せる形（URLと手順）にする。

    値も鍵らしい物は断る（手順に入れないのと同じ理由）。URLに入る値は
    URLとして正しい形に直す（`&` や空白で、別の引数に化けないように）。
    """
    values = {str(k): str(v) for k, v in (values or {}).items()}
    need = list(recipe.get("params") or [])
    missing = [n for n in need if not values.get(n, "").strip()]
    if missing:
        return {"ok": False, "missing": missing,
                "error": "「" + "」「".join(missing) + "」を渡してください"
                         f"（手順「{recipe.get('name', '')}」の空け所）"}
    for n in need:
        v = values[n]
        if len(v) > MAX_VALUE:
            return {"ok": False, "error": f"「{n}」が長すぎます（{MAX_VALUE}字まで）"}
        why = secrets_guard.why(v)
        if why:
            return {"ok": False, "error": f"「{n}」に{why}。手順には入れません"}

    def put(text: str, in_url: bool = False) -> str:
        return _PARAM.sub(lambda m: (quote(values[m.group(1)], safe="")
                                     if in_url else values[m.group(1)])
                          if m.group(1) in values else m.group(0), text or "")

    steps = []
    for s in recipe.get("steps") or []:
        kind = s.get("do")
        steps.append({"do": kind,
                      "target": put(s.get("target", ""), in_url=(kind == "goto")),
                      "value": put(s.get("value", ""), in_url=(kind == "goto"))})
    return {"ok": True, "url": put(recipe.get("url", ""), in_url=True), "steps": steps}


_SAY = {
    "goto": lambda s: f"{s['value'] or s['target']} へ移る",
    "click": lambda s: f"「{s['target']}」を押す",
    "fill": lambda s: f"「{s['target']}」に「{s['value']}」と入力",
    "select": lambda s: f"「{s['target']}」で「{s['value']}」を選ぶ",
    "press": lambda s: f"{s['target'] or 'Enter'} キーを押す",
    "wait": lambda s: f"{s['value'] or '1000'}ミリ秒待つ",
}


def preview(name: str, values: Optional[Dict[str, str]] = None) -> str:
    """確認カードに出す「実際に流す手順」。無ければ空文字。

    値が渡っていれば入れた形で、渡っていなければ `{顧客名}` のまま見せる
    （確認のあとで値を足すことはできないので、そのまま見せて気づいてもらう）。
    """
    r = get(name) if name else None
    if not r:
        return ""
    got = materialize(r, values or {})
    url = got["url"] if got.get("ok") else r.get("url", "")
    steps = got["steps"] if got.get("ok") else (r.get("steps") or [])
    lines = [f"手順「{r.get('name', '')}」（{len(steps)}手）", f"開く: {url}"]
    for i, s in enumerate(steps, 1):
        say = _SAY.get(s.get("do"), lambda x: str(x.get("do")))
        lines.append(f"{i}. {say({'target': s.get('target', ''), 'value': s.get('value', '')})}")
    return "\n".join(lines)


def summary_line(r: dict) -> str:
    """一覧の1行（AIにも人にも同じ物を見せる）。"""
    host = host_of(r.get("url", "")) or "?"
    n = len(r.get("steps") or [])
    params = r.get("params") or []
    extra = f"・入れる値: {'、'.join(params)}" if params else ""
    kind = "押す手順あり" if touches(r) else "読むだけ"
    desc = f" — {r['description']}" if r.get("description") else ""
    return f"「{r.get('name', '')}」（{host}・{n}手・{kind}{extra}）{desc}"
