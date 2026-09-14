# imagegen.py — 画像生成（無料エンジン ＋ HuggingFace のモデル）
# =====================================================================
# 既定は Pollinations（APIキー不要）。プロンプトから決定的なURLを組み立てて返す
# （同じプロンプト＋seedなら同じ画像）。生成物は artifacts に image として保存し、
# HOMEの「生成物」でサムネイル表示・オープンできる。
#
# engine="hf" にすると、設定で「画像生成」に割り当てた HuggingFace のモデル
# （FLUX等）で生成する。HFは画像のバイト列を返すので、hfhub に保管して
# /hf/image/{id} のURLとして返す（履歴や <img> がURL前提のため形を揃える）。
# HFは1枚あたり数秒〜数十秒かかるので、枚数は控えめに抑える。
# =====================================================================

import hashlib
import urllib.parse

HF_MAX_VARIANTS = 2               # HFは遅いので枚数を絞る（タイムアウト回避）

# 用途別のアスペクト比プリセット（SNSや印刷でよく使う比率）
ASPECTS = {
    "1:1": (1024, 1024, "正方形（Instagram）"),
    "4:5": (1024, 1280, "縦長（Instagramフィード）"),
    "9:16": (1080, 1920, "縦全画面（ストーリー/Reels）"),
    "16:9": (1280, 720, "横長（YouTube/スライド）"),
    "3:2": (1200, 800, "写真（ブログ挿絵）"),
}

MAX_VARIANTS = 4


def engines() -> dict:
    """選べるエンジンと、それぞれが今使えるかを返す（UIの判断用）。"""
    model = ""
    ready = False
    try:
        import hfhub
        model = hfhub.assigned("image")
        ready = bool(model) and hfhub.token_ready()
    except Exception:
        pass
    return {
        "pollinations": {"label": "無料（キー不要）", "ready": True, "model": ""},
        "hf": {"label": "HuggingFace のモデル", "ready": ready, "model": model,
               "hint": "" if ready else "設定 →「つなぐ」で「画像生成」に割り当ててください"},
    }


def _resolve_engine(engine: str) -> str:
    """auto は「HFに画像モデルが割り当ててあればHF、無ければ無料エンジン」。"""
    engine = (engine or "auto").strip().lower()
    if engine in ("hf", "huggingface"):
        return "hf"
    if engine == "pollinations":
        return "pollinations"
    return "hf" if engines()["hf"]["ready"] else "pollinations"


def generate_variants(prompt: str, n: int = 2, aspect: str = "1:1", offset: int = 0,
                      engine: str = "auto") -> dict:
    """同じ指示で複数のバリエーションを作る。{ok, images:[{url,seed}], aspect}。

    Pollinations は seed で絵柄が変わるため、seed を振り分けることで
    「同じ指示の別案」を並べて選べるようにする（ChatGPTの複数枚生成に相当）。
    offset をずらすと、同じ指示のまま“さらに別の案”を出せる（リロール）。
    """
    prompt = (prompt or "").strip()
    if not prompt:
        return {"error": "画像の指示(prompt)が空です"}
    if aspect not in ASPECTS:
        aspect = "1:1"
    try:
        n = max(1, min(int(n or 2), MAX_VARIANTS))
    except Exception:
        n = 2
    try:
        offset = max(0, int(offset or 0))
    except Exception:
        offset = 0
    w, h, _ = ASPECTS[aspect]
    used = _resolve_engine(engine)
    if used == "hf":
        n = min(n, HF_MAX_VARIANTS)

    images = []
    errors = []
    for i in range(n):
        res = (_generate_hf(prompt, w, h, variant=offset + i) if used == "hf"
               else generate(prompt, w, h, variant=offset + i))
        if res.get("ok"):
            images.append({"url": res["url"], "seed": res["seed"],
                           "provider": res.get("provider", used)})
        elif res.get("error"):
            errors.append(res["error"])
    if not images:
        # HFで失敗したら理由を返す（黙って無料エンジンにすり替えない）
        return {"error": errors[0] if errors else "画像を生成できませんでした"}
    out = {"ok": True, "images": images, "aspect": aspect, "width": w, "height": h,
           "prompt": prompt, "offset": offset, "engine": used}
    if used == "hf":
        out["model"] = engines()["hf"]["model"]
        out["max_variants"] = HF_MAX_VARIANTS
    if errors:
        out["partial_error"] = errors[0]
    return out


def _generate_hf(prompt: str, width: int, height: int, variant: int = 0) -> dict:
    """HuggingFace のモデルで1枚生成し、URLで取り出せる形にして返す。"""
    try:
        import hfhub
    except Exception as e:
        return {"error": f"HuggingFace連携を読み込めませんでした: {e}"}
    model = hfhub.assigned("image")
    if not model:
        return {"error": "画像生成に使うHuggingFaceモデルが未割り当てです"
                         "（設定 →「つなぐ」で「画像生成」に割り当ててください）"}
    res = hfhub.run_image(model, prompt, width, height)
    if res.get("error"):
        return res
    img_id = hfhub.save_image(res["data"], res.get("mime", "image/png"), prompt)
    base = int(hashlib.md5(prompt.encode("utf-8")).hexdigest()[:8], 16)
    return {"ok": True, "url": hfhub.image_url(img_id),
            "provider": f"huggingface:{model}",
            "seed": (base + int(variant or 0) * 7919) % 100000}


def generate(prompt: str, width: int = 1024, height: int = 1024, variant: int = 0) -> dict:
    """プロンプトから画像URLを作る。{ok, url, provider} / {ok:False, error}。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"ok": False, "error": "画像の指示(prompt)が空です"}
    try:
        w = max(256, min(int(width or 1024), 1536))
        h = max(256, min(int(height or 1024), 1536))
    except Exception:
        w, h = 1024, 1024
    # 同じプロンプトなら同じ絵（再現性）。variant を変えると別案になる。
    base = int(hashlib.md5(prompt.encode("utf-8")).hexdigest()[:8], 16)
    seed = (base + int(variant or 0) * 7919) % 100000
    enc = urllib.parse.quote(prompt[:400], safe="")
    url = (f"https://image.pollinations.ai/prompt/{enc}"
           f"?width={w}&height={h}&nologo=true&seed={seed}")
    return {"ok": True, "url": url, "provider": "pollinations", "seed": seed}
