# renderer.py — 動画/音声レンダリング（スケルトン / 後で実装）
# =================================================================
# 環境音(asset_engine.generate_ambient_wav)＋静止画(generate_thumbnail/画像)から、
# YouTube投稿用の動画ファイル等を合成する工程。実合成(FFmpeg等)は後で実装する。
#
# いまは“枠だけ”：未実装の関数は None を返す（絶対にraiseしない）。これにより
# publisher / run_publisher 側は「アセット未提供 → 公式アップロードはskip」と
# 安全に振る舞い、ここを実装すれば自動的に実投入できるようになる。
# =================================================================

import os
import shutil
import subprocess


def _ffmpeg():
    return shutil.which("ffmpeg")


def is_available():
    """FFmpeg が使えるか（headless環境にインストールされているか）。"""
    return _ffmpeg() is not None


def _safe_name(text, fallback="asset"):
    s = "".join(c for c in (text or "") if c.isalnum() or c in " -_").strip()[:40]
    return s or fallback


def _build_ffmpeg_cmd(ff, image_path, audio_path, out_path, seconds, fps=2):
    """静止画(ループ)＋環境音(ループ)を seconds 秒の mp4 にする ffmpeg コマンドを組む。
    画像は 1280x720 に収まるよう scale＋pad（16:9で余白は中央）。"""
    return [
        ff, "-y",
        "-loop", "1", "-framerate", str(fps), "-i", image_path,
        "-stream_loop", "-1", "-i", audio_path,
        "-t", str(int(seconds)),
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
               "pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-tune", "stillimage", "-r", str(fps),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        out_path,
    ]


def render_video(job, audio_path=None, image_path=None, out_dir="rendered", minutes=None):
    """静止画(image)＋環境音(audio)をループして mp4 を合成する。
    ffmpeg または入力ファイルが無ければ None を返す（絶対にraiseしない）。
    尺は minutes（既定: 環境変数 RENDER_MINUTES または 10分）。"""
    ff = _ffmpeg()
    if not ff:
        return None
    if not (audio_path and os.path.exists(audio_path)) or not (image_path and os.path.exists(image_path)):
        return None
    try:
        mins = float(minutes if minutes is not None else (os.environ.get("RENDER_MINUTES") or 10))
        seconds = max(5, int(mins * 60))
        os.makedirs(out_dir, exist_ok=True)
        jid = str(job.get("id", "x"))[:8]
        out_path = os.path.join(out_dir, f"{jid}_{_safe_name(job.get('theme'))}.mp4")
        cmd = _build_ffmpeg_cmd(ff, image_path, audio_path, out_path, seconds)
        timeout = int(os.environ.get("RENDER_TIMEOUT_SEC") or 1800)
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        if r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return out_path
        return None
    except Exception:
        return None


def build_assets(job):
    """1ジョブから配信用アセット {"images":[png], "video": mp4} を生成する。
    画像は asset_image キーで生成。ffmpeg があれば環境音＋画像から mp4 も合成する。
    publish_shutterstock には画像、publish_youtube には動画が渡る（認証情報がある場合のみ実投入）。"""
    assets = {}
    try:
        import asset_engine
        import key_manager
        payload = job.get("payload", {}) or {}
        theme = job.get("theme", "")
        prompt = (payload.get("shutterstock", {}) or {}).get("title_en") or theme
        os.makedirs("rendered", exist_ok=True)
        jid = str(job.get("id", "x"))[:8]
        safe = _safe_name(theme)

        # 画像（asset_image 用途キー：env の用途別→共通）
        _, key = key_manager.resolve_key("asset_image")
        img, _src = asset_engine.generate_image(prompt, gemini_key=key)
        img_path = None
        if img:
            img_path = os.path.join("rendered", f"{jid}_{safe}.png")
            with open(img_path, "wb") as f:
                f.write(img)
            assets["images"] = [img_path]

        # 動画（ffmpeg があるときだけ：環境音ベースクリップ→ループmp4）
        if img_path and is_available():
            sec = int(os.environ.get("RENDER_AUDIO_SEC") or 60)
            wav, _kind = asset_engine.generate_ambient_wav(theme, duration_sec=sec)
            if wav:
                aud_path = os.path.join("rendered", f"{jid}_{safe}.wav")
                with open(aud_path, "wb") as f:
                    f.write(wav)
                vid = render_video(job, audio_path=aud_path, image_path=img_path)
                if vid:
                    assets["video"] = vid
    except Exception:
        pass
    return assets


# =================================================================
# Forge Lab 用：絵コンテ（複数シーン）から画像＋ナレーションのMP4を合成する
# =================================================================
def _fetch_image_bytes(prompt, width=1280, height=720, timeout=60):
    """Pollinations（無料・キー不要）から画像を取得する。失敗時は None。"""
    try:
        import requests, urllib.parse
        url = (f"https://image.pollinations.ai/prompt/{urllib.parse.quote(prompt or 'cinematic scene')}"
               f"?width={width}&height={height}&nologo=true")
        r = requests.get(url, timeout=timeout)
        if r.status_code == 200 and r.content:
            return r.content
    except Exception:
        return None
    return None


def _clip_from_image_audio(ff, image_path, audio_path, out_path):
    """1枚画像＋ナレーション音声から、音声長に合わせた16:9のMP4クリップを作る。"""
    cmd = [
        ff, "-y",
        "-loop", "1", "-i", image_path,
        "-i", audio_path,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
               "pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart",
        out_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=600)
        if r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return out_path
    except Exception:
        return None
    return None


def render_forge_video(scenes, image_prompt="", out_dir="rendered", lang="ja"):
    """複数シーン [{"narration": 日本語, "visual": 英語(任意)}] から、
    各シーンの画像（Pollinations）＋ナレーション（gTTS）を合成し、連結したMP4のパスを返す。
    FFmpeg/ネットワークが無ければ None（絶対にraiseしない）。"""
    ff = _ffmpeg()
    if not ff or not scenes:
        return None
    try:
        from gtts import gTTS
        import tempfile, uuid
        work = tempfile.mkdtemp(prefix="forgevid_")
        clips = []
        for i, sc in enumerate(scenes[:8]):  # 安全のため最大8シーン
            narration = (sc.get("narration") or "").strip()
            visual = (sc.get("visual") or image_prompt or narration or "cinematic scene").strip()
            if not narration:
                narration = visual
            img = _fetch_image_bytes(f"{image_prompt}, {visual}" if image_prompt else visual)
            if not img:
                continue
            img_path = os.path.join(work, f"img_{i}.png")
            with open(img_path, "wb") as f:
                f.write(img)
            try:
                aud_path = os.path.join(work, f"aud_{i}.mp3")
                gTTS(text=narration[:500], lang=lang).save(aud_path)
            except Exception:
                continue
            clip = _clip_from_image_audio(ff, img_path, aud_path, os.path.join(work, f"clip_{i}.mp4"))
            if clip:
                clips.append(clip)
        if not clips:
            return None
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"forge_{uuid.uuid4().hex[:8]}.mp4")
        if len(clips) == 1:
            shutil.copy(clips[0], out_path)
            return out_path
        list_file = os.path.join(work, "list.txt")
        with open(list_file, "w", encoding="utf-8") as f:
            for c in clips:
                f.write(f"file '{c}'\n")
        r = subprocess.run(
            [ff, "-y", "-f", "concat", "-safe", "0", "-i", list_file,
             "-c", "copy", "-movflags", "+faststart", out_path],
            capture_output=True, timeout=600,
        )
        if r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return out_path
        shutil.copy(clips[0], out_path)  # 連結失敗時は先頭クリップを返す
        return out_path
    except Exception:
        return None
