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
