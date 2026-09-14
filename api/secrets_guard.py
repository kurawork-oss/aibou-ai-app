"""
secrets_guard.py — 秘密を、記憶に入れない（仕様§12・§22）。

なぜ要るか
----------
このアプリは会話を長期記憶に入れる。入れる先は端末の中（IndexedDB）と
サーバー側（Supabase）で、どちらも**あとで会話に混ぜてAIへ渡る**。

つまり、会話の中で1度でも鍵を口にすると、それが記憶に残り、以後ずっと
毎回AIへ送られる。

    「GEMINIのキー、AIzaSyC… これで合ってる？」
      → そのまま記憶に入る
      → 以後、関係ない話でも「関連する記憶」として毎回添付される

鍵は Credential Vault（暗号化して保存し、AIには渡さない）が持つ物で、
記憶が持つ物ではない。

どちらへ倒すか
--------------
**迷ったら入れない。** 鍵らしき文字列を覚え損ねても、失うのは利便性だけ。
逆を間違えると、秘密が残り続ける。

ただし行き過ぎにも気をつける。「パスワードを変えた」「GEMINI_API_KEY を
設定した」のような**鍵そのものを含まない文**は、ふつうの記憶として残す。
そこまで弾くと生活の記録が穴だらけになり、しかも本人には理由が分からない。

なぜ「形」で見るのか
--------------------
鍵はどれも、人が書く文章には出てこない形をしている——決まった頭文字と、
20文字以上続く英数字。この2つが揃う並びは、まず鍵かトークンしかない。
逆に注文番号や型番は短いので、長さの下限を置けば巻き込まない。
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

MASK = "〈伏せました〉"

# ── 鍵の形 ──────────────────────────────────────────────────────────
#
# (名前, 正規表現) の組。名前は「なぜ弾いたか」を言うために持つ。
# **鍵そのものは理由に載せない**（理由は画面にもログにも出る）。
PATTERNS: List[Tuple[str, "re.Pattern[str]"]] = [
    ("Googleのキー", re.compile(r"\bAIza[0-9A-Za-z\-_]{30,}")),
    ("OpenAI・Claudeのキー", re.compile(r"\bsk-[A-Za-z0-9\-_]{20,}")),
    ("HuggingFaceのトークン", re.compile(r"\bhf_[A-Za-z0-9]{20,}")),
    ("GitHubのトークン", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("Slackのトークン", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("Notionのトークン", re.compile(r"\b(?:secret|ntn)_[A-Za-z0-9]{20,}")),
    ("署名つきトークン（JWT）",
     re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("秘密鍵", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # ユーザー名とパスワードが入った接続文字列
    ("接続文字列（パスワード入り）",
     re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s/:@]+:[^\s/@]+@[^\s]+")),
    # AWS
    ("AWSのキー", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
]

# 「パスワードは ○○」の形。値が短くても、そう書いてあるなら秘密。
#
# 「パスワードを変えた」は弾かない——**値が続いていない**から。
# ここを「パスワード」という語だけで弾くと、生活の記録が消える。
_PASSWORD = re.compile(
    r"(?:パスワード|ぱすわーど|password|passwd|pass\s*phrase|パスフレーズ|暗証番号)"
    r"\s*(?:は|が|:|：|=)\s*"
    r"(\S{6,})"
)


def has_secret(text: Optional[str]) -> bool:
    """その文を記憶に入れてよいか。True なら入れない。"""
    return bool(why(text))


def why(text: Optional[str]) -> str:
    """弾く理由。弾かないなら空文字。

    理由を返すのは、あとから「なぜ覚えてくれなかったのか」を追えるように
    するため。ここが無いと、黙って落ちた記憶を調べようがない。
    **鍵そのものは絶対に載せない。**
    """
    s = (text or "").strip()
    if not s:
        return ""
    for name, pat in PATTERNS:
        if pat.search(s):
            return f"{name}らしき文字列が含まれています"
    if _PASSWORD.search(s):
        return "パスワードらしき文字列が含まれています"
    return ""


def redact(text: Optional[str]) -> str:
    """鍵の所だけ伏せて、文は残す。

    記憶に入れる前ではなく、**画面やログに出すとき**に使う。
    「何か言ったが、それは秘密だった」ことは残したいが、中身は要らない。
    """
    s = text or ""
    if not s:
        return s
    for _name, pat in PATTERNS:
        s = pat.sub(MASK, s)
    s = _PASSWORD.sub(lambda m: m.group(0).replace(m.group(1), MASK), s)
    return s
