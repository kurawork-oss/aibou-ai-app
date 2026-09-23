"""
browser_router.py — そのページを「どこで」開くかを決める（仕様§3 Tool Router）。

なぜ要るか
----------
ブラウザを開ける場所は3つある。

    手元の台（相棒）  … あなたとしてログイン済み（あなたのChrome か 専用ブラウザ）
    サーバー          … 誰にもログインしていない（ENABLE_BROWSER のときだけ）
    ブラウザ無し      … HTTPで1枚取って文字を剥がす（web_read と同じ）

これまで、AIには場所ごとに別の道具を見せていた（browser_visit / local_browse /
local_browse_act）。つまり**AIが場所を選んでいた**。ところが「このサイトは
ログインが要るか」「どの台なら開けるか」は、AIには分からない——分かるのは、
それぞれの台が知らせてくる `--site` の一覧を持っている、こちら側だけ。

仕様§3「ユーザーにはOpenCLI・Playwright・APIの違いを意識させない。相棒自身が
適切な道具を選ぶ」。道具は `browser_open`（読む）と `browser_act`（押す）の2つに
畳んで、場所はここで決める。

決め方
------
  1. 名指しの台があれば、その台（そのサイトを許していなければ断る）
  2. そのサイトを `--site` に入れている、動いている台が
       1台   … その台で開く（ログイン済み）
       2台以上 … **勝手に選ばず聞く**（読み違い・書き違いを避ける。localagent と同じ）
       0台   … ログインは要らないサイトとみなして、サーバーのブラウザ
                → それも無ければ、読むだけならHTTPで（押すことはできないと言う）

「どの台でもない＝ログイン不要」とみなすのは、**台の側が許していないサイトを、
あなたとして開く道が無い**から。許したサイトの一覧が、そのまま「ログインして
使うサイト」の一覧になっている。

危なさも、場所で決まる
----------------------
同じ「押す」でも、誰にもログインしていないブラウザで押すのと、**あなたとして**
押すのとでは重さが違う。risk.py はここに聞いて段階を決める（`level_hint`）。
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import urlparse

# 場所の名前（画面と結果に出す）
LABELS = {
    "local": "手元のパソコン（ログイン済み）",
    "server": "サーバーのブラウザ（ログイン無し）",
    "http": "ページの文字だけ（ブラウザ無し）",
}


def _user() -> str:
    try:
        import config
        return config.current_user_id() or "local"
    except Exception:
        return "local"


def host_of(url: str) -> str:
    try:
        p = urlparse((url or "").strip())
    except Exception:
        return ""
    if (p.scheme or "").lower() not in ("http", "https"):
        return ""
    return (p.hostname or "").lower()


def _server_browser() -> bool:
    try:
        import browser
        return browser.available()
    except Exception:
        return False


def plan(url: str, kind: str = "open", device: str = "",
         user_id: Optional[str] = None) -> dict:
    """そのURLを、どこで開くか。

    kind: "open"（読む）/ "act"（押す・打ち込む）/ "recipe"（決まった手順）

    返す形:
      {"ok": True, "route": "local", "device": id, "name": 台の名前, ...}
      {"ok": True, "route": "server" | "http", ...}
      {"ok": False, "error": 理由, "choose": [台の名前...]?}
    """
    import localagent

    uid = user_id or _user()
    host = host_of(url)
    if not host:
        return {"ok": False, "error": "http(s) のURLを渡してください"}

    candidates = localagent.devices_for_host(uid, host)

    # ① 名指し
    if device:
        chosen = localagent.pick(uid, device)
        if not chosen.get("ok"):
            return chosen
        if chosen["device"] not in {c["device"] for c in candidates}:
            return {"ok": False,
                    "error": (f"「{chosen['name']}」では {host} を開けません"
                              f"（その台の --site に入っていないか、ブラウザが入っていません）")}
        return {"ok": True, "route": "local", "device": chosen["device"],
                "name": chosen["name"], "host": host, "label": LABELS["local"]}

    # ② そのサイトを許している台
    if len(candidates) == 1:
        c = candidates[0]
        return {"ok": True, "route": "local", "device": c["device"], "name": c["name"],
                "host": host, "label": LABELS["local"]}
    if len(candidates) > 1:
        names = [c["name"] for c in candidates]
        return {"ok": False, "choose": names,
                "error": (f"{host} を開ける台が{len(names)}台あります"
                          f"（{' / '.join(names)}）。どちらで開くか決めてください"),
                "next": "台の名前を言ってもらえれば、そこで開きます"}

    # ③ どの台も許していない → ログインの要らないサイトとして
    if _server_browser():
        return {"ok": True, "route": "server", "host": host, "label": LABELS["server"]}
    if kind == "open":
        return {"ok": True, "route": "http", "host": host, "label": LABELS["http"]}
    return {"ok": False,
            "error": (f"{host} を操作できる場所がありません。"
                      f"ログインが要るサイトなら、手元の相棒の --site に {host} を足して"
                      f"ください。ログインの要らないサイトなら、サーバーのブラウザ"
                      f"（ENABLE_BROWSER=1）で操作できます")}


def route_level(tool: str, route: str) -> int:
    """その場所で動かしたときの段階（risk.py の0〜3）。

      browser_open … 手元（あなたとして読む）なら2。中身がAIへ渡るので
                     この用事の中で完結しない。そうでなければ0（公開ページを読むだけ）
      browser_act  … 手元（あなたとして押す）なら3。押した先が送信かもしれず、
                     そのときはあなたとして送られる。そうでなければ0
                     （誰にもログインしていないブラウザ。以前の browser_visit と同じ扱い）
    """
    if route == "local":
        return 2 if tool == "browser_open" else 3
    return 0


def level_hint(tool: str, params: Optional[dict]) -> Optional[int]:
    """risk.py 用。場所によって危なさが変わる道具の段階。分からなければ None。"""
    if tool not in ("browser_open", "browser_act"):
        return None
    url = str((params or {}).get("url") or "")
    if not url:
        return None
    try:
        got = plan(url, "open" if tool == "browser_open" else "act",
                   str((params or {}).get("device") or ""))
    except Exception:
        return None
    if not got.get("ok"):
        # 動かせない（場所が無い・2台あって決まっていない・名指しの台が開けない）。
        # **何も起きないので0。** ここで重いほうに倒すと、動かない操作に
        # 「あなたとして押してよいか」を聞き、押されたあとで「場所がありません」
        # 「どちらの台か決めてください」と返すことになる。先に理由を返して、
        # 台が決まった呼び直しで改めて重さを測るほうが、話が通る。
        #
        # 測ってから動かすまでの間に台がつながった場合は、実行する側が
        # 「通した重さ（0）」を超えるので止める（risk.within_ceiling）。
        return 0
    return route_level(tool, got["route"])
