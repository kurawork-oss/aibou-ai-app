# config.py — 環境設定とSupabaseクライアント（遅延生成 / 絶対にcrashしない）
# =====================================================================
# このAPIは「JARVISの脳」。Next.jsフロントから叩かれるスタンドアロンなFastAPI。
# Streamlit / core.py には一切依存しない（自己完結）。
#
# 設定はすべて os.environ から読む。python-dotenv で .env も自動ロードする。
# Supabase は必要になった時に1度だけ作る（遅延）。未設定でも落ちず、記憶・収益系は
# 空を返して優雅に縮退する（graceful degradation）。
# =====================================================================

import os

from dotenv import load_dotenv

# .env をロード（存在しなければ無視）。本番（Cloud Run / HF Spaces）は実環境変数を使う。
load_dotenv()

# ── 環境変数 ────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
APP_TOKEN = os.environ.get("APP_TOKEN", "").strip()          # 任意：APIをBearerで保護
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "*").strip() or "*"

# APIキーをSupabaseに保存する際の暗号化マスターシークレット。
# 未設定なら SUPABASE_SERVICE_KEY → APP_TOKEN の順にフォールバックして鍵を導出する
# （どれも無ければ暗号化なし＝メモリ運用のみ想定）。値は絶対に外へ出さない。
KEYCHAIN_SECRET = os.environ.get("KEYCHAIN_SECRET", "").strip()

# 既定モデル（必要なら環境変数で上書き可）
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"

# 既定の音声（edge-tts）
DEFAULT_TTS_VOICE = os.environ.get("DEFAULT_TTS_VOICE", "ja-JP-KeitaNeural").strip() or "ja-JP-KeitaNeural"
# 既定の話速（edge-tts rate, 例 "+0%" / "-20%" / "+30%"）
DEFAULT_TTS_RATE = os.environ.get("DEFAULT_TTS_RATE", "+0%").strip() or "+0%"


# ── Gemini 設定（遅延・1度だけ） ─────────────────────────────────
_gemini_ready = False


def gemini_configured() -> bool:
    """GEMINI_API_KEY があり configure 済みなら True。
    Keychain 経由で os.environ に後から入ったキーも拾えるよう、毎回 env を確認する。"""
    global _gemini_ready, GEMINI_API_KEY
    if _gemini_ready:
        return True
    key = GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return False
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        GEMINI_API_KEY = key
        _gemini_ready = True
        return True
    except Exception:
        return False


def reconfigure_gemini(api_key: str) -> bool:
    """Keychain でキーが更新された時に呼ぶ。次回の get_gemini_model から新キーを使う。"""
    global _gemini_ready, GEMINI_API_KEY
    GEMINI_API_KEY = (api_key or "").strip()
    _gemini_ready = False
    return gemini_configured()


def get_gemini_model(model_name: str | None = None):
    """GenerativeModel を返す。未設定なら None（絶対にraiseしない）。"""
    if not gemini_configured():
        return None
    try:
        import google.generativeai as genai
        return genai.GenerativeModel(model_name or GEMINI_MODEL)
    except Exception:
        return None


# ── Supabase クライアント（遅延・1度だけ） ───────────────────────
_supabase_client = None
_supabase_tried = False


def get_supabase():
    """Supabaseクライアントを返す。未設定/失敗時は None（記憶・収益系は空で縮退）。"""
    global _supabase_client, _supabase_tried
    if _supabase_client is not None:
        return _supabase_client
    if _supabase_tried:
        return None
    _supabase_tried = True
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        return None
    try:
        from supabase import create_client
        _supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        return _supabase_client
    except Exception:
        _supabase_client = None
        return None
