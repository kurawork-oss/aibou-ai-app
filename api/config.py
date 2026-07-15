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
# 既定のSupabaseプロジェクト（環境変数で上書き可）。URLのみ既定値を持ち、
# service_role キーは必ず環境変数から与える（接続には両方が必要）。
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip() or "https://hwjmojipsablfevtjzln.supabase.co"
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
APP_TOKEN = os.environ.get("APP_TOKEN", "").strip()          # 任意：APIをBearerで保護
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "*").strip() or "*"

# Supabase Auth の JWT を受け付けるための署名シークレット（HS256）。
# ダッシュボード → Settings → API → JWT Secret の値。設定するとフロントの
# ログインセッション(access_token)がそのままAPIの認証に使える。
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "").strip()
# "1"/"true" で認証必須化（APP_TOKEN 一致 or 有効なSupabase JWTが無ければ401）。
REQUIRE_AUTH = os.environ.get("REQUIRE_AUTH", "").strip().lower() in ("1", "true", "yes")

# APIキーをSupabaseに保存する際の暗号化マスターシークレット。
# 未設定なら SUPABASE_SERVICE_KEY → APP_TOKEN の順にフォールバックして鍵を導出する
# （どれも無ければ暗号化なし＝メモリ運用のみ想定）。値は絶対に外へ出さない。
KEYCHAIN_SECRET = os.environ.get("KEYCHAIN_SECRET", "").strip()

# 既定モデル（必要なら環境変数 GEMINI_MODEL で上書き可）。
# モデル名は時々使えなくなる（新規ユーザー不可・廃止等）ため、下の候補リストから
# 実際にこのキーで使えるものを list_models() で自動選択する（_resolve_model）。
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip()

# 使いたい順の候補（上から順に、利用可能な最初のものを採用）。
# 新規キーは「最新世代しか無料枠が無い」(古い世代は limit:0 の429) ため最新優先。
_MODEL_CANDIDATES = [
    m for m in [
        GEMINI_MODEL,             # 明示指定があれば最優先
        "gemini-flash-latest",    # Googleが維持する「現行flash」エイリアス
        "gemini-flash-lite-latest",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
    ] if m
]

# quota 0 (429 limit: 0) と判明したモデル。以後の解決から除外する。
_model_blacklist: set = set()


def is_zero_quota_429(err) -> bool:
    """「無料枠が0 / 使い切り」の429かどうか（この時はモデル切替が有効）。"""
    s = str(err)
    return "429" in s and ("limit: 0" in s or "free_tier" in s or "quota" in s.lower())


def mark_model_unavailable(name: str) -> None:
    """quota 0 だったモデルを除外し、次回から別モデルを解決させる。"""
    global _resolved_model
    if name:
        _model_blacklist.add(name)
    _resolved_model = None

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
    global _gemini_ready, GEMINI_API_KEY, _resolved_model
    GEMINI_API_KEY = (api_key or "").strip()
    _gemini_ready = False
    _resolved_model = None  # キーが変われば使えるモデルも変わりうる → 再判定
    return gemini_configured()


# 実際にこのキーで使えると判定したモデル名（1度だけ解決してキャッシュ）
_resolved_model: str | None = None


def _list_available_models() -> set:
    """このキーで generateContent が使えるモデル名の集合（テストで差し替え可能）。"""
    import google.generativeai as genai
    out = set()
    for m in genai.list_models():
        methods = getattr(m, "supported_generation_methods", []) or []
        if "generateContent" in methods:
            out.add((m.name or "").replace("models/", ""))
    return out


def _resolve_model() -> str:
    """このAPIキーで generateContent が使えるモデルを候補から自動選択する。
    list_models() で実際に利用可能なものを見て決める（廃止・新規不可を回避）。
    失敗時は候補の先頭 or "gemini-2.0-flash" にフォールバック。"""
    global _resolved_model
    if _resolved_model:
        return _resolved_model
    usable_candidates = [c for c in _MODEL_CANDIDATES if c not in _model_blacklist]
    fallback = usable_candidates[0] if usable_candidates else "gemini-flash-latest"
    try:
        available = _list_available_models() - _model_blacklist
        # 候補を優先順に、利用可能なら採用
        for cand in usable_candidates:
            if cand in available:
                _resolved_model = cand
                return cand
        # 候補が全滅でも、使える flash 系のうち「一番新しい世代」を選ぶ
        # （例: gemini-3-flash > gemini-2.5-flash。将来の新モデルも自動で拾う）
        import re
        best = None
        best_ver = -1.0
        for name in available:
            m = re.match(r"gemini-(\d+(?:\.\d+)?)-flash", name)
            if m and "vision" not in name and "8b" not in name:
                ver = float(m.group(1))
                # 同バージョンなら短い名前（無印flash）を優先
                if ver > best_ver or (ver == best_ver and best and len(name) < len(best)):
                    best, best_ver = name, ver
        if best:
            _resolved_model = best
            return best
        if available:
            _resolved_model = sorted(available)[0]
            return _resolved_model
    except Exception:
        pass
    _resolved_model = fallback
    return fallback


def get_gemini_model(model_name: str | None = None):
    """GenerativeModel を返す。未設定なら None（絶対にraiseしない）。
    model_name 未指定なら、このキーで使える最適なモデルを自動選択する。"""
    if not gemini_configured():
        return None
    try:
        import google.generativeai as genai
        return genai.GenerativeModel(model_name or _resolve_model())
    except Exception:
        return None


def generate_resilient(prompt, stream: bool = False, model_name: str | None = None):
    """generate_content の quota-0 429 に強いラッパー。
    使えないモデル（無料枠0）に当たったらブラックリスト→次候補で1度だけ再試行する。
    Gemini未設定なら None。その他の例外はそのまま raise（呼び出し元の整形を維持）。"""
    model = get_gemini_model(model_name)
    if model is None:
        return None
    try:
        return model.generate_content(prompt, stream=stream)
    except Exception as e:
        if not is_zero_quota_429(e):
            raise
        used = (getattr(model, "model_name", "") or "").replace("models/", "")
        mark_model_unavailable(used)
        model2 = get_gemini_model(model_name)
        if model2 is None:
            raise
        return model2.generate_content(prompt, stream=stream)


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
