"""
facts.py — 会話から「後で効く事実」を取り出す（仕様§10・§12・§22）。

なぜ要るか
----------
これまで長期記憶に入っていたのは、**本人の発言をそのまま**選り分けた物
だけ（webapp/src/lib/worthRemembering.ts）。形だけを見ているので、
こういう言い方は全部こぼれる:

    「今度の沖縄、3泊で考えてるんだけどおすすめある？」
        → 問いかけの形なので捨てる。**沖縄に行く**は残らない
    「昨日から左膝が痛くて、走るのやめてる」
        → 残るが文はそのまま。半年後に読むと「昨日」がいつか分からない
    「妻が甲殻類だめなんだよね。だから店はいつも肉」
        → 1行に2つの事実。引くときはどちらか片方しか要らない

形で選ぶのをやめられない理由もあった。判定をAIにやらせると、発言のたびに
往復が増えて、そのぶん**返事が始まるまでの待ち時間**になる。

どこに置いたか
--------------
返事が**終わったあと**。利用者はもう読み始めているので、ここでの往復は
待ち時間にならない。落ちても会話には何も起きない（記憶が1回増えないだけ）。

何を取って、何を取らないか
--------------------------
取る  : 本人と、その周りについての**続く事実**
        （好み・体質・家族・仕事・持ち物・約束事・決めたこと・予定）
取らない: 指示、問いかけそのもの、AIが言ったこと、作った物の中身、
        その場かぎりの話、**鍵とパスワード**

相対的な日付はその場で絶対の日付に直す。「来月引っ越す」は半年後に読むと
嘘になる。ここを直さないと、記憶が増えるほど嘘が増える。

取りこぼしと取りすぎ、どちらに倒すか
------------------------------------
取りすぎ（雑談が1件混ざる）は、記憶の画面から消せるし実害も小さい。
取りこぼしは本人から見えない。……が、ここは worthRemembering と違って
**倒す先が逆**。あちらは本人の発言そのままなので間違いようがないが、
こちらはAIが書き直した文が入る。**言っていないことが事実として残る**のが
いちばん困るので、ここは「はっきり言われたことだけ」に寄せる。
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Iterable, List, Optional, Sequence

import jsonout
import secrets_guard

# 1回で取る上限。多いほど当たりも増えるが、外れも一緒に増える。
MAX_PER_CALL = 5
# 1件の長さ。長い物は「事実」ではなく要約になっている。
MAX_LEN = 160
MIN_LEN = 4
# 渡す会話の長さ（文字）。ここを伸ばすと精度は上がるが毎回の費用も上がる。
MAX_CONTEXT = 4000

# 取り出した文に混ざりやすい、事実ではない言い回し。
# 「〜かもしれない」「〜したいと言っている」は、**推測**をそのまま
# 事実として残してしまう形。
_GUESS = re.compile(
    r"(かもしれ|かも知れ|だろう|と思われ|ようだ|らしい[。．]?$|"
    r"推測|おそらく|たぶん|可能性がある)"
)

# AI側のことを書いてしまったもの。「ユーザーは」「あなたは」で始まる
# 三人称の説明は、読み返したときに誰の話か分からなくなる。
_ABOUT_AI = re.compile(r"^(AI|アシスタント|Claude|Gemini|わたし|私)(は|が|の)")

_PROMPT = """\
あなたは、ある人の長期記憶を作る係です。

下の会話から、**あとでこの人を手伝うときに効く事実**だけを抜き出します。

抜き出す:
- 好み・苦手・体質・アレルギー
- 家族や同僚など、周りの人のこと
- 仕事・役割・使っている道具や環境
- 決めたこと・約束・予定
- 住んでいる場所、持ち物、続いている習慣

抜き出さない:
- この人がAIに出した指示（「〜して」「〜を作って」）
- 質問そのもの
- AIが言ったこと・作った物の中身
- その場かぎりの話（「今その画面を開いている」など）
- 鍵・パスワード・トークンの類（**絶対に出さない**）

守ること:
- **会話ではっきり言われたことだけ**。推測しない。言い換えで意味を足さない
- 「明日」「来月」「去年」などは、今日の日付（{today}）を使って
  **具体的な日付や年月**に直す
- 1件は1つの事実。1文で、それだけ読んで分かるように書く
- 主語が要るときは「本人」ではなく、会話で使われた呼び方を使う
- 何も無ければ空の配列を返す。無理に絞り出さない

すでに覚えていること（同じ内容なら出さない）:
{known}

会話:
{turns}

JSONの配列だけを返してください。ほかの文字は書かないでください。
形: [{{"text": "事実", "importance": 0か1}}]
importance は、この人を手伝ううえで欠かせないもの（体質・アレルギー・
家族構成・仕事の根っこ）だけ 1、ほかは 0。
"""


def today_str(now: Optional[_dt.date] = None) -> str:
    d = now or _dt.date.today()
    return d.strftime("%Y年%m月%d日")


def _as_text(turns: Sequence[dict]) -> str:
    """会話を、AIに読ませる形に畳む。

    後ろ（新しいほう）から詰める。切るなら古いほうを切る——直近の発言に
    いちばん新しい事実が入っている。
    """
    lines: List[str] = []
    total = 0
    for t in reversed(list(turns or [])):
        role = str((t or {}).get("role") or "user")
        body = str((t or {}).get("content") or "").strip()
        if not body:
            continue
        who = "本人" if role in ("user", "me") else "AI"
        line = f"{who}: {body}"
        if total + len(line) > MAX_CONTEXT:
            break
        lines.append(line)
        total += len(line)
    lines.reverse()
    return "\n".join(lines)


def build_prompt(turns: Sequence[dict], known: Iterable[str] = (),
                 today: Optional[str] = None) -> str:
    seen = [str(k).strip() for k in (known or []) if str(k).strip()][:40]
    return _PROMPT.format(
        today=today or today_str(),
        known="\n".join(f"- {k}" for k in seen) or "（まだありません）",
        turns=_as_text(turns),
    )


def _same(a: str, b: str) -> bool:
    """同じことを言っているか（記号と空白の違いは無視する）。"""
    flat = lambda s: re.sub(r"[\s。．、,！!？?・]", "", s)   # noqa: E731
    return flat(a) == flat(b)


def clean(items, known: Iterable[str] = ()) -> List[dict]:
    """AIが返した物を、記憶に入れてよい形だけに絞る。

    ここはAIを信じない側の砦。プロンプトで禁じたことは、必ずここでも見る。
    """
    out: List[dict] = []
    seen = [str(k) for k in (known or []) if str(k).strip()]
    if not isinstance(items, list):
        return out
    for raw in items:
        if isinstance(raw, str):
            raw = {"text": raw}
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        if len(text) < MIN_LEN or len(text) > MAX_LEN:
            continue
        # 鍵は何があっても入れない（仕様§12・§22）。記憶は毎回AIへ送られる。
        if secrets_guard.has_secret(text):
            continue
        if _GUESS.search(text):
            continue
        if _ABOUT_AI.match(text):
            continue
        if any(_same(text, k) for k in seen):
            continue
        if any(_same(text, o["text"]) for o in out):
            continue
        try:
            imp = int(raw.get("importance") or 0)
        except Exception:
            imp = 0
        out.append({"text": text, "importance": 1 if imp >= 1 else 0})
        seen.append(text)
        if len(out) >= MAX_PER_CALL:
            break
    return out


def extract(turns: Sequence[dict], known: Iterable[str] = (),
            today: Optional[str] = None) -> List[dict]:
    """会話から事実を取り出す。取れなければ空。**例外は出さない**。

    呼ぶ側（返事のあと）は、ここが落ちても何もしない。記憶が1回増えない
    だけで、会話にも画面にも影響しない。
    """
    text = _as_text(turns)
    if len(text) < 12:
        return []
    try:
        import llm
        # 仕事の種類を分けてあるので、`ROUTE_FACTS=ollama` と書けば
        # 「記憶を作るところだけは外へ出さない」ができる。
        raw = llm.generate_text(
            build_prompt(turns, known, today), max_tokens=500, task="facts")
    except Exception:
        return []
    if not raw:
        return []
    return clean(jsonout.extract_list(raw) or [], known)
