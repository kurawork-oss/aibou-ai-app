# asset_engine.py — AIbou アセット生成エンジン（環境音 / サムネイル / 画像）
# =================================================================
# 副業オートメーションで使う「実体アセット」を生成する。
#   - generate_ambient_wav() : numpy で環境音(雨/焚き火/風/波/ホワイトノイズ)を合成 → WAVバイト列
#   - generate_thumbnail()   : PIL でグラデ背景＋テーマ文字のサムネ(1280x720) → PNGバイト列
#   - generate_image()       : 画像生成API(あれば)で生成、無ければ generate_thumbnail にフォールバック
#
# 依存は numpy / Pillow / 標準ライブラリ wave のみ（mp3化したい場合のみ pydub を任意利用）。
# 外部APIキーが無くても必ず何らかのアセットを返す（オフラインでも動く）。絶対にraiseしない。
# =================================================================

import io
import os
import wave
import math
import datetime

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except Exception:
    NUMPY_AVAILABLE = False

try:
    from PIL import Image, ImageDraw, ImageFont
    PIL_AVAILABLE = True
except Exception:
    PIL_AVAILABLE = False

try:
    import requests
except Exception:
    requests = None


SAMPLE_RATE = 22050

# テーマ→環境音の種類を推定するキーワード辞書
_KIND_KEYWORDS = {
    "rain": ["雨", "rain", "梅雨", "しずく", "雫"],
    "fire": ["焚き火", "暖炉", "薪", "fire", "campfire", "ロッジ", "lodge", "暖"],
    "wind": ["風", "wind", "高原", "山", "雪", "snow", "森", "forest"],
    "wave": ["波", "海", "wave", "ocean", "sea", "beach", "渚"],
    "white": ["集中", "勉強", "作業", "ノイズ", "noise", "睡眠", "sleep"],
}


def detect_kind(theme):
    """テーマ文字列から環境音の種類を推定する。該当なしは 'fire'(汎用の心地よい音)。"""
    t = (theme or "").lower()
    for kind, words in _KIND_KEYWORDS.items():
        if any(w.lower() in t for w in words):
            return kind
    return "fire"


def _pcm16_bytes(signal):
    """float配列[-1,1] を 16bit PCM の WAV バイト列にする。"""
    sig = np.clip(signal, -1.0, 1.0)
    pcm = (sig * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _brown_noise(n):
    """ブラウンノイズ（低音寄り）。ホワイトノイズの累積和を正規化。"""
    white = np.random.uniform(-1, 1, n)
    brown = np.cumsum(white)
    brown = brown - np.mean(brown)
    m = np.max(np.abs(brown)) or 1.0
    return brown / m


def _fade(signal, fade_sec=0.8):
    """先頭・末尾をフェードして、ループ時のプチノイズを抑える。"""
    f = int(SAMPLE_RATE * fade_sec)
    if f * 2 >= len(signal) or f <= 0:
        return signal
    env = np.ones(len(signal))
    ramp = np.linspace(0, 1, f)
    env[:f] = ramp
    env[-f:] = ramp[::-1]
    return signal * env


def generate_ambient_wav(theme=None, duration_sec=10, kind="auto"):
    """環境音を合成して (wav_bytes, kind) を返す。失敗時は (None, error_str)。"""
    if not NUMPY_AVAILABLE:
        return None, "⚠️ numpy が無いため環境音を生成できません。"
    try:
        if kind == "auto":
            kind = detect_kind(theme)
        duration_sec = max(1, min(int(duration_sec), 60))
        n = SAMPLE_RATE * duration_sec
        t = np.linspace(0, duration_sec, n, endpoint=False)

        if kind == "rain":
            # ホワイトノイズを高域寄りに（差分）＋ランダムな雨粒
            white = np.random.uniform(-1, 1, n)
            sig = np.diff(white, prepend=white[0]) * 0.6
            drops = np.zeros(n)
            for _ in range(duration_sec * 40):
                p = np.random.randint(0, n)
                drops[p] += np.random.uniform(0.3, 0.8)
            sig = sig + drops * 0.3
        elif kind == "wind":
            base = _brown_noise(n)
            lfo = 0.5 + 0.5 * np.sin(2 * np.pi * 0.08 * t)  # ゆっくり強弱
            sig = base * lfo
        elif kind == "wave":
            base = _brown_noise(n)
            swell = 0.5 + 0.5 * np.sin(2 * np.pi * 0.12 * t)  # 寄せては返す
            sig = base * (swell ** 2)
        elif kind == "white":
            sig = np.random.uniform(-1, 1, n) * 0.5
        else:  # fire
            base = _brown_noise(n) * 0.7
            crackle = np.zeros(n)
            for _ in range(duration_sec * 12):
                p = np.random.randint(0, n)
                crackle[p] += np.random.uniform(0.4, 1.0)
            sig = base + crackle * 0.25

        sig = _fade(sig / (np.max(np.abs(sig)) or 1.0) * 0.85)
        return _pcm16_bytes(sig), kind
    except Exception as e:
        return None, f"⚠️ 環境音生成エラー: {e}"


def _load_font(size):
    """環境にあるフォントを順に試す。無ければデフォルト。"""
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    ):
        try:
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
        except Exception:
            pass
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _hash_hue(seed):
    """テーマ文字列から決定的に色相を作る（同テーマ＝同系色）。"""
    h = 0
    for ch in (seed or "x"):
        h = (h * 31 + ord(ch)) % 360
    return h


def _hsv_to_rgb(h, s, v):
    c = v * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = v - c
    r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(h / 60) % 6]
    return (int((r + m) * 255), int((g + m) * 255), int((b + m) * 255))


def generate_thumbnail(title, subtitle=None, width=1280, height=720):
    """グラデ背景＋テーマ文字のサムネを生成して PNG バイト列を返す。失敗時は None。"""
    if not PIL_AVAILABLE:
        return None
    try:
        hue = _hash_hue(title)
        top = _hsv_to_rgb(hue, 0.55, 0.85)
        bottom = _hsv_to_rgb((hue + 40) % 360, 0.65, 0.35)
        img = Image.new("RGB", (width, height), top)
        draw = ImageDraw.Draw(img)
        for y in range(height):
            r = y / height
            col = tuple(int(top[i] * (1 - r) + bottom[i] * r) for i in range(3))
            draw.line([(0, y), (width, y)], fill=col)

        font = _load_font(72)
        sub_font = _load_font(36)
        text = (title or "Untitled")[:40]
        if font:
            try:
                bbox = draw.textbbox((0, 0), text, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            except Exception:
                tw, th = font.getsize(text) if hasattr(font, "getsize") else (len(text) * 36, 72)
            x, y = (width - tw) // 2, (height - th) // 2 - 20
            draw.text((x + 3, y + 3), text, font=font, fill=(0, 0, 0))   # 影
            draw.text((x, y), text, font=font, fill=(255, 255, 255))
            if subtitle and sub_font:
                st_text = subtitle[:60]
                try:
                    sb = draw.textbbox((0, 0), st_text, font=sub_font)
                    sw = sb[2] - sb[0]
                except Exception:
                    sw = len(st_text) * 18
                draw.text(((width - sw) // 2, y + th + 30), st_text, font=sub_font, fill=(235, 235, 235))

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


def generate_image(prompt, openai_key=None, size="1024x1024"):
    """画像生成。OpenAI画像APIキーがあればそれで生成、無ければサムネにフォールバック。
    returns: (png_bytes, source)  source は 'openai' または 'placeholder' または None。"""
    key = openai_key or os.environ.get("OPENAI_API_KEY", "")
    if key and requests is not None:
        try:
            r = requests.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": "gpt-image-1", "prompt": prompt, "size": size, "n": 1},
                timeout=120,
            )
            data = r.json()
            item = (data.get("data") or [{}])[0]
            if item.get("b64_json"):
                import base64
                return base64.b64decode(item["b64_json"]), "openai"
            if item.get("url"):
                img = requests.get(item["url"], timeout=60)
                return img.content, "openai"
        except Exception:
            pass
    png = generate_thumbnail(prompt)
    return (png, "placeholder") if png else (None, None)
