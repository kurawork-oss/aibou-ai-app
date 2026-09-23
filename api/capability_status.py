"""
capability_status.py — 「いま何ができて、何ができないか、なぜか、次に何をするか」。

なぜ要るか
----------
できることは30以上ある。そのうちどれが**いま本当に使えるか**は、鍵・OAuth・
保存先・機能のパックが絡み合って決まる。これまでその答えは1か所に無く、
利用者は**押して失敗してから**理由を知っていた。

    「Notionから議事録を探して」
      → 実行 → 失敗 →「Notionが繋がっていません」

先に分かっていれば、失敗する必要はない。

答えられないといけないのは4つ。

  ・できるか
  ・できないなら、なぜか
  ・何をすればできるようになるか
  ・それは自分でできることか、持ち主に頼むことか

最後の1つが抜けると、押しても始まらないボタンを押し続けることになる
（アプリ登録が済んでいない連携がそれ）。

どちらへ倒すか
--------------
**「使える」と嘘をつかない**を優先する。押して失敗するより、先に
「繋いでいません」と言うほうがよい。ただし逆も同じくらい悪い——使えるのに
使えないと言うと、人はそこで諦める。だから「判断できないときは使える側」に
倒し、判断できたときだけはっきり断る。

capabilities.py との違い
------------------------
あちらは**道具の台帳**（# の一覧・AIに渡す説明・パック）。
こちらは**状態**（繋がっているか・なぜ駄目か）。分けてあるのは、道具が
増えても状態の種類は増えないから。道具1つずつに状態を持たせると、
30個ぶん同じ判定を書くことになる。
"""

from __future__ import annotations

from typing import Dict, List, Optional, Set

# ── 状態（仕様§6） ──────────────────────────────────────────────────
#
# 画面はこの8つしか知らない。ここに無い値を返すと、色も文言も付かずに
# 素通りする（＝「何も言っていない」になる）。
STATUSES = (
    "connected",                # 繋がっていて、使える
    "available",               # 繋ぐ物が無く、そのまま使える
    "not_connected",           # 繋げば使える（押すのは本人）
    "authentication_required",  # 繋いだが、許可が切れている
    "permission_required",      # 繋がっているが、権限が足りない
    "configuration_required",   # 設定が要る（鍵の入力・アプリ登録）
    "unavailable",             # いまは使わない設定にしてある
    "error",                   # 調べようとして失敗した
)

USABLE = ("connected", "available")


# ── 何を見るか ──────────────────────────────────────────────────────
#
# kind:
#   "key"   … 鍵が入っていれば使える（AIの鍵など。代理で持てない物）
#   "oauth" … 押して許可すれば使える
#   "local" … 端末の中で完結する（繋ぐ物が無い）
#   "off"   … この配り方では使えない（環境変数で切ってある等）
GROUPS: List[dict] = [
    {"id": "ai", "name": "AI（頭脳）", "kind": "key",
     "keys": ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
              "HUGGINGFACE_TOKEN", "XAI_API_KEY", "OLLAMA_URL"],
     "pack": "core",
     "tools": [],
     "why_missing": "AIの鍵が1つも入っていません",
     "next": "設定 →「つなぐ」 に GEMINI_API_KEY を入れてください（無料枠があります）",
     "action": {"kind": "key", "name": "GEMINI_API_KEY"}},

    {"id": "memory", "name": "記憶", "kind": "local", "pack": "core",
     "tools": ["remember", "recall"]},

    {"id": "web", "name": "Web検索・ページ取得", "kind": "local", "pack": "core",
     "tools": ["web_search", "web_read", "browser_open"]},

    {"id": "tasks", "name": "タスク・予定", "kind": "local", "pack": "core",
     "tools": ["add_task", "add_agenda", "list_state"]},

    {"id": "google_calendar", "name": "Googleカレンダー", "kind": "oauth",
     "provider": "google", "pack": "core",
     "tools": ["calendar_add", "calendar_list"],
     "permissions": ["calendar.events"]},

    {"id": "gmail", "name": "Gmail", "kind": "oauth", "provider": "google",
     "pack": "core", "tools": ["email_inbox", "send_email"],
     "permissions": ["gmail.readonly"]},

    {"id": "google_drive", "name": "Googleドライブ・ドキュメント", "kind": "oauth",
     "provider": "google", "pack": "make",
     "tools": ["drive_upload", "google_doc", "google_sheet", "create_google_slides"],
     "permissions": ["drive.file"]},

    {"id": "notion", "name": "Notion", "kind": "oauth", "provider": "notion",
     "pack": "core", "tools": ["notion_add"]},

    {"id": "slack", "name": "Slack", "kind": "oauth", "provider": "slack",
     "pack": "core", "tools": []},

    {"id": "github", "name": "GitHub", "kind": "oauth", "provider": "github",
     "pack": "dev", "tools": []},

    {"id": "make", "name": "画像・スライド・資料をつくる", "kind": "local",
     "pack": "make",
     "tools": ["generate_image", "create_document", "create_slides",
               "create_spreadsheet"]},

    {"id": "voice", "name": "声（読み上げ・聞き取り）", "kind": "local",
     "pack": "core", "tools": []},

    {"id": "vision", "name": "画像を見て答える", "kind": "key",
     "keys": ["GEMINI_API_KEY"], "pack": "core", "tools": [],
     "why_missing": "画像を読むにはGeminiの鍵が要ります",
     "next": "設定 →「つなぐ」 に GEMINI_API_KEY を入れてください",
     "action": {"kind": "key", "name": "GEMINI_API_KEY"}},

    {"id": "notify", "name": "通知（端末・LINE・Discord・Slack）", "kind": "local",
     "pack": "core", "tools": ["notify"]},

    {"id": "income", "name": "副業の自動化", "kind": "local", "pack": "income",
     "owner_only": True, "tools": ["enqueue_income", "income_status"]},

    {"id": "shell", "name": "パソコンのコマンド実行", "kind": "off",
     "env": "ENABLE_SHELL", "pack": "dev", "tools": [],
     "why_missing": "安全のため、既定で切ってあります",
     "next": "自分のサーバーで動かしていて、必要な場合だけ ENABLE_SHELL=1 を設定します",
     "action": {"kind": "env", "name": "ENABLE_SHELL"}},

    {"id": "browser", "name": "サーバーのブラウザ（ログイン無しの公開ページ）", "kind": "off",
     "env": "ENABLE_BROWSER", "pack": "core", "tools": ["browser_act"],
     "why_missing": "メモリを多く使うため、既定で切ってあります",
     "next": ("ログインが要るサイトは、手元のパソコンの相棒が開きます（こちらは要りません）。"
              "公開ページも押して操作したいときだけ、余裕のある置き場で ENABLE_BROWSER=1 に。"
              "無料のRender（512MB）では、開いたページ1枚でAPIごと落ちることがあります"),
     "action": {"kind": "env", "name": "ENABLE_BROWSER"}},

    {"id": "local_agent", "name": "パソコンの中を触る（手元の相棒）",
     "kind": "local_agent", "pack": "core",
     "tools": ["local_list", "local_read", "local_write", "local_append",
               "obsidian_note", "browser_open", "browser_act"],
     "why_missing": "手元のパソコンで相棒を動かしていません",
     "next": ("設定 → つなぐ →「手元のパソコン」で合言葉を作り、"
              "パソコンで `python aibou_local.py` を動かします"),
     "action": {"kind": "local_agent"}},
]


# ── 外の様子を見る口（テストで差し替えられるよう、関数に分けてある） ──

def _key(name: str) -> str:
    try:
        import keychain
        v = keychain.get_key(name)
        if v:
            return str(v).strip()
    except Exception:
        pass
    import os
    return os.environ.get(name, "").strip()


def _oauth_status(provider: str) -> dict:
    import oauth
    return oauth.status(provider)


def _packs_on(is_owner: bool) -> Set[str]:
    import capabilities
    return set(capabilities.enabled_packs(is_owner))


def _local_agent_status() -> dict:
    import config
    import localagent
    return localagent.status(config.current_user_id() or "local")


def _env_on(name: str) -> bool:
    import os
    return (os.environ.get(name, "") or "").strip().lower() in ("1", "true", "yes", "on")


# ── 1件ぶんの判定 ───────────────────────────────────────────────────

def _judge(g: dict, packs: Set[str]) -> dict:
    """その1つが、いまどの状態か。

    パックを先に見るのは、切ってある物の連携状況を調べても意味が無いから
    （調べるぶん遅くなるし、繋いでいないという表示だけが増える）。
    """
    out: Dict[str, object] = {
        "id": g["id"], "name": g["name"], "kind": g["kind"],
        "pack": g.get("pack", "core"),
        "tools": list(g.get("tools") or []),
    }
    if g.get("permissions"):
        out["permissions"] = list(g["permissions"])

    # ① 使わない設定にしてある
    if g.get("pack") and g["pack"] not in packs:
        out.update(status="unavailable", connected=False,
                   why="この機能のかたまりを、使わない設定にしてあります",
                   next="設定 → つなぐ →「使う機能」で入れ直せます",
                   action={"kind": "pack", "name": g["pack"]})
        return out

    # ② この配り方では動かさない（環境変数で切ってある）
    if g["kind"] == "off":
        if g.get("env") and _env_on(g["env"]):
            out.update(status="available", connected=True)
            return out
        out.update(status="unavailable", connected=False,
                   why=g.get("why_missing", "いまは使えません"),
                   next=g.get("next", ""),
                   action=g.get("action", {"kind": "none"}))
        return out

    # ③ 鍵が要る物
    if g["kind"] == "key":
        # 中身は見るが、**持たない**。ここは会話へ流れる（§12）。
        got = [n for n in g.get("keys", []) if _key(n)]
        if got:
            out.update(status="connected", connected=True, using=got[0])
            return out
        out.update(status="configuration_required", connected=False,
                   why=g.get("why_missing", "鍵が入っていません"),
                   next=g.get("next", ""),
                   action=g.get("action", {"kind": "none"}))
        return out

    # ④ 押して繋ぐ物
    if g["kind"] == "oauth":
        st = _oauth_status(g["provider"])
        label = st.get("label") or g["provider"]
        if st.get("error"):
            out.update(status="error", connected=False,
                       why=f"{label}の状態を調べられませんでした（{st['error']}）",
                       next="しばらくしてからもう一度お試しください",
                       action={"kind": "none"})
            return out
        if st.get("connected"):
            out.update(status="connected", connected=True)
            if st.get("account"):
                out["account"] = st["account"]
            return out
        if not st.get("configured"):
            # アプリ登録がまだ。押しても始まらないので、**押させない**。
            out.update(status="configuration_required", connected=False,
                       needs_owner=True,
                       why=f"{label}のアプリ登録が、まだ済んでいません",
                       next=f"このアプリの持ち主が{label}の登録を済ませると、押すだけで繋がります",
                       action={"kind": "none"})
            return out
        out.update(status="not_connected", connected=False,
                   why=f"{label}と繋いでいません",
                   next=f"設定 → つなぐ →「{label}」を押すと繋がります",
                   action={"kind": "oauth", "provider": g["provider"],
                           "path": f"/connect/{g['provider']}"})
        return out

    # ⑤ 手元のパソコンで動く相棒（仕様§29〜§31）
    #
    # 「合言葉を作った」と「いま動いている」は別のこと。作っただけで
    # 「使えます」と出すと、頼んだあとで無言のまま返事が来なくなる。
    if g["kind"] == "local_agent":
        st = _local_agent_status()
        if st.get("online"):
            # 何台動いているかを出す。1台のつもりが2台だったときに
            # 「どちらに頼んだのか」を後から辿れるようにするため。
            live = [d["name"] for d in (st.get("devices") or []) if d.get("online")]
            out.update(status="connected", connected=True,
                       account=" / ".join(live) if live else "")
            return out
        out.update(status="not_connected", connected=False,
                   why=st.get("why") or g.get("why_missing", ""),
                   next=st.get("next") or g.get("next", ""),
                   action=g.get("action", {"kind": "none"}))
        return out

    # ⑥ 繋ぐ物が無い（端末とサーバーだけで完結する）
    out.update(status="available", connected=True)
    return out


# ── 全体 ────────────────────────────────────────────────────────────

def snapshot(is_owner: bool = True) -> List[dict]:
    """いまの状態を、全部ぶん。

    1件の判定が落ちても**全体は返す**。自己診断が出なくなるのは、
    いちばんそれを見たい瞬間（どこかが壊れているとき）だから。
    """
    try:
        packs = _packs_on(is_owner)
    except Exception:
        # パックが読めないなら、絞らない（使えるのに隠すほうが悪い）
        packs = {g.get("pack", "core") for g in GROUPS}

    out: List[dict] = []
    for g in GROUPS:
        if g.get("owner_only") and not is_owner:
            continue
        try:
            out.append(_judge(g, packs))
        except Exception as e:
            out.append({
                "id": g["id"], "name": g["name"], "kind": g.get("kind", ""),
                "pack": g.get("pack", "core"), "tools": list(g.get("tools") or []),
                "status": "error", "connected": False,
                "why": f"状態を調べられませんでした（{str(e)[:120]}）",
                "next": "設定 →「しらべる」 で接続を確かめてください",
                "action": {"kind": "none"},
            })
    return out


def find(cap_id: str, is_owner: bool = True) -> Optional[dict]:
    for c in snapshot(is_owner):
        if c["id"] == cap_id:
            return c
    return None


def usable_ids(is_owner: bool = True) -> Set[str]:
    return {c["id"] for c in snapshot(is_owner) if c["status"] in USABLE}


def summary(is_owner: bool = True) -> str:
    """会話にそのまま出せる形。

    仕様§40 の但し書き——「毎回ユーザーに一覧を表示しない」——があるので、
    これは**聞かれたときだけ**使う。だから短くする必要はないが、
    使えない物には必ず次の一手を添える。

    鍵そのものは絶対に載せない。ここは会話へ流れ、そのままAIへ渡る。
    """
    snap = snapshot(is_owner)
    ok = [c for c in snap if c["status"] in USABLE]
    ng = [c for c in snap if c["status"] not in USABLE]

    lines = ["【いま使えること】"]
    lines += [f"  ✓ {c['name']}" for c in ok] or ["  （まだありません）"]
    if ng:
        lines.append("")
        lines.append("【まだ使えないこと】")
        for c in ng:
            lines.append(f"  — {c['name']}：{c.get('why', '')}")
            if c.get("next"):
                lines.append(f"     → {c['next']}")
    return "\n".join(lines)
