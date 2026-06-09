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


def is_available():
    """FFmpeg等のレンダリング基盤が使えるか（現状は未実装なので False）。"""
    return False


def render_video(job, audio_path=None, image_path=None, out_dir="rendered"):
    """環境音＋静止画 → 動画(mp4)を合成する（未実装スタブ）。
    実装後は出力パスを返す。現状は None。"""
    # TODO: FFmpeg で image を背景に audio を尺いっぱい流す mp4 を生成する
    return None


def render_audio_track(job, out_dir="rendered", minutes=60):
    """短い環境音サンプルを長尺(ループ＋フェード)に伸ばす（未実装スタブ）。"""
    # TODO: asset_engine の波形をループ連結し、指定分数のWAV/MP3を書き出す
    return None


def build_assets(job):
    """1ジョブから配信用アセット一式 {"video":..., "images":[...]} を生成する。
    現状は何も作らず空dictを返す（publisher側は skip になる）。"""
    return {}
