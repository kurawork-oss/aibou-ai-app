# imagegen.py — 画像生成（キー不要・無料）
# =====================================================================
# 既定は Pollinations（APIキー不要）。プロンプトから決定的なURLを組み立てて返す
# （同じプロンプト＋seedなら同じ画像）。生成物は artifacts に image として保存し、
# HOMEの「生成物」でサムネイル表示・オープンできる。
# =====================================================================

import hashlib
import urllib.parse


def generate(prompt: str, width: int = 1024, height: int = 1024) -> dict:
    """プロンプトから画像URLを作る。{ok, url, provider} / {ok:False, error}。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"ok": False, "error": "画像の指示(prompt)が空です"}
    try:
        w = max(256, min(int(width or 1024), 1536))
        h = max(256, min(int(height or 1024), 1536))
    except Exception:
        w, h = 1024, 1024
    seed = int(hashlib.md5(prompt.encode("utf-8")).hexdigest()[:8], 16) % 100000
    enc = urllib.parse.quote(prompt[:400], safe="")
    url = (f"https://image.pollinations.ai/prompt/{enc}"
           f"?width={w}&height={h}&nologo=true&seed={seed}")
    return {"ok": True, "url": url, "provider": "pollinations"}
