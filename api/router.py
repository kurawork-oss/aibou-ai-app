"""
router.py — どのAIに頼むかを、仕事の中身で選ぶ（仕様§15・§16・§17・§18）。

なぜ要るか
----------
これまで使えたのは Gemini / HuggingFace / OpenAI の3つで、選び方は
「設定した順」だけだった。仕事の中身は見ていない。

  ・こみ入ったコードの直し   → 得意なモデルがある
  ・人に見せたくない文章     → 手元（Ollama）で済ませたい
  ・ふつうの会話             → 無料枠で足りる

いちばん大事な線引き
--------------------
**勝手に課金しない。**

鍵を入れただけの従量課金サービスを、こちらの判断で使い始めてはいけない。
請求は利用者に行く。鍵を入れる理由は「たまに使いたい」であって、
「これから全部これで」ではない。

  ・無料で使える物（Gemini無料枠・HuggingFace・手元のOllama）
      → 自動で選んでよい
  ・お金がかかる物（Claude・GPT・Grok）
      → **その仕事に指名されたときだけ**

指名は `ROUTE_<仕事>` という鍵で持つ（例: `ROUTE_CODE=anthropic`）。
KEYCHAIN に入れても環境変数に入れてもよい。

全部落ちたときの最後の受け皿にだけは、課金する物も入れる——黙って
止まるより、料金がかかっても答えが出るか、せめて理由が出るほうがよい。

llm.py との分担
---------------
ここは**選ぶだけ**。実際に喋らせるのは llm.py。分けてあるのは、選び方は
仕事が増えるたびに変わるが、喋らせ方は提供元ごとに1回書けば済むため。
"""

from __future__ import annotations

import os
from typing import Dict, List

# ── 提供元の台帳 ────────────────────────────────────────────────────
#
# paid … 使うとお金がかかるか。ここが False の物だけ、こちらの判断で
#        選んでよい。抜けていると「無料だと思って選ぶ」が起きるので、
#        テストで必ず埋まっていることを見張っている。
PROVIDERS: Dict[str, dict] = {
    "gemini": {
        "label": "Gemini", "key": "GEMINI_API_KEY", "paid": False,
        "note": "無料枠がある。既定。",
    },
    "huggingface": {
        "label": "HuggingFace", "key": "HUGGINGFACE_TOKEN", "paid": False,
        "note": "無料枠がある。",
    },
    "ollama": {
        "label": "Ollama（手元）", "key": "OLLAMA_URL", "paid": False,
        "note": "自分のパソコンで動く。外へ出ないので、見せたくない文章に向く。",
    },
    "anthropic": {
        "label": "Claude", "key": "ANTHROPIC_API_KEY", "paid": True,
        "note": "使った分だけ請求される。仕事を指名したときだけ使う。",
    },
    "openai": {
        "label": "GPT", "key": "OPENAI_API_KEY", "paid": True,
        "note": "使った分だけ請求される。仕事を指名したときだけ使う。",
    },
    "grok": {
        "label": "Grok", "key": "XAI_API_KEY", "paid": True,
        "note": "使った分だけ請求される。仕事を指名したときだけ使う。",
    },
}

# ── 仕事の種類 ──────────────────────────────────────────────────────
#
# 既定の並びは「無料のうち、その仕事に向いた順」。
TASKS: Dict[str, List[str]] = {
    # ふだんの会話。速さと無料枠がすべて。
    "chat": ["gemini", "huggingface"],
    # コード。手元は遅いことが多いので後ろ。
    "code": ["gemini", "huggingface"],
    # 長い文章の要約。入力の長さに強い順。
    "long": ["gemini", "huggingface"],
    # 人に見せたくない物。**外へ出さない**のが第一条件。
    "private": ["ollama", "gemini", "huggingface"],
    # 画像を読む。いまは Gemini だけ。
    "vision": ["gemini"],
}

DEFAULT_TASK = "chat"


def _key(name: str) -> str:
    """設定値（KEYCHAIN → 環境変数）。テストではここを差し替える。"""
    try:
        import keychain
        v = keychain.get_key(name)
        if v:
            return str(v).strip()
    except Exception:
        pass
    return os.environ.get(name, "").strip()


def _ready(provider: str) -> bool:
    p = PROVIDERS.get(provider)
    return bool(p and _key(p["key"]))


def _named(task: str) -> str:
    """その仕事に指名された提供元（`ROUTE_CODE=anthropic` など）。"""
    name = (_key(f"ROUTE_{task.upper()}") or "").strip().lower()
    return name if name in PROVIDERS else ""


def order_for(task: str = DEFAULT_TASK) -> List[str]:
    """その仕事で試す順。先頭から順に使い、落ちたら次へ。

    並べ方:
      ① 指名された物（あれば・鍵があれば）
      ② その仕事に向いた無料の物
      ③ 残りの無料の物
      ④ 課金する物（最後の受け皿。ここまで来るのは全部落ちたとき）
    """
    want = TASKS.get(task) or TASKS[DEFAULT_TASK]
    out: List[str] = []

    named = _named(task)
    if named and _ready(named):
        out.append(named)

    for p in want:
        if p not in out and not PROVIDERS[p]["paid"] and _ready(p):
            out.append(p)
    for p, meta in PROVIDERS.items():
        if p not in out and not meta["paid"] and _ready(p):
            out.append(p)
    for p, meta in PROVIDERS.items():
        if p not in out and meta["paid"] and _ready(p):
            out.append(p)
    return out


def pick(task: str = DEFAULT_TASK) -> str:
    """その仕事で最初に使う提供元。1つも無ければ "none"。"""
    order = order_for(task)
    return order[0] if order else "none"


def status() -> List[dict]:
    """画面に出す一覧。

    **鍵そのものは絶対に載せない。** ここは設定画面へそのまま出る。
    載せるのは「入っているかどうか」だけ。
    """
    out = []
    for pid, meta in PROVIDERS.items():
        out.append({
            "id": pid,
            "label": meta["label"],
            "paid": bool(meta["paid"]),
            "ready": _ready(pid),
            "key": meta["key"],          # 鍵の**名前**（値ではない）
            "note": meta.get("note", ""),
        })
    return out


def routes() -> Dict[str, str]:
    """いま、どの仕事をどこへ回しているか。"""
    return {task: pick(task) for task in TASKS}
