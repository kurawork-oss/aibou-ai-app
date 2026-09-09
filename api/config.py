# config.py — 環境設定とSupabaseクライアント（遅延生成 / 絶対にcrashしない）
# =====================================================================
# このAPIは「JARVISの脳」。Next.jsフロントから叩かれるスタンドアロンなFastAPI。
# Streamlit / core.py には一切依存しない（自己完結）。
#
# 設定はすべて os.environ から読む。python-dotenv で .env も自動ロードする。
# Supabase は必要になった時に1度だけ作る（遅延）。未設定でも落ちず、記憶・収益系は
# 空を返して優雅に縮退する（graceful degradation）。
# =====================================================================

import contextvars
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

# オーナー（このアプリの持ち主）。ここに書いた人だけが、持ち主専用のモード
# （副業=INCOME / 自己進化=AI STUDIO）を使える。
# どちらも未設定のときは「1人で使っている」とみなして全機能を出す
# （設定し忘れで自分が締め出されないようにするため）。
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "").strip().lower()
OWNER_USER_ID = os.environ.get("OWNER_USER_ID", "").strip()

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
    if name:
        _model_blacklist.add(name)
    _resolved_model.clear()

# 既定の音声（edge-tts）
DEFAULT_TTS_VOICE = os.environ.get("DEFAULT_TTS_VOICE", "ja-JP-KeitaNeural").strip() or "ja-JP-KeitaNeural"
# 既定の話速（edge-tts rate, 例 "+0%" / "-20%" / "+30%"）
DEFAULT_TTS_RATE = os.environ.get("DEFAULT_TTS_RATE", "+0%").strip() or "+0%"


# ── Gemini 設定 ──────────────────────────────────────────────────
# 利用者ごとに違うAPIキーを使えるようにする必要がある（Aさんの鍵でBさんが
# 動くと、請求も利用履歴もAさんに乗ってしまう）。
# ところが google-generativeai は genai.configure() でプロセス全体に1つの鍵を
# 設定する作りで、モデル側に鍵を渡す口が無い。そこで
#   ・いま処理している人の鍵を毎回引く（_key_resolver 経由）
#   ・configure と生成呼び出しを1つの錠でくくり、他のリクエストが割り込んで
#     鍵を差し替えられないようにする
# という形にしている。錠の中にいるのは「鍵を設定して要求を出す」までで、
# 応答の受け取り（ストリームの読み出し）は外に出るので、詰まらない。
import threading

_gemini_lock = threading.RLock()
_configured_key: str | None = None        # いま genai に入っている鍵

# 鍵の引き方は keychain が知っている（利用者の鍵 → サーバー共通鍵）。
# config は keychain を import できない（逆向きに import しているため）ので、
# keychain 側から自分を登録してもらう。
_key_resolver = None


def set_key_resolver(fn) -> None:
    """keychain.get_key を登録してもらう（起動時に1度）。"""
    global _key_resolver
    _key_resolver = fn


def current_gemini_key() -> str:
    """いま処理している人が使うべき Gemini の鍵。"""
    if _key_resolver is not None:
        try:
            k = (_key_resolver("GEMINI_API_KEY") or "").strip()
            if k:
                return k
        except Exception:
            pass
    return GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY", "").strip()


def _apply_key(key: str) -> bool:
    """genai に鍵を設定する（同じ鍵なら何もしない）。錠の中から呼ぶこと。"""
    global _configured_key
    if not key:
        return False
    if _configured_key == key:
        return True
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        _configured_key = key
        return True
    except Exception:
        return False


def gemini_configured() -> bool:
    """いまの利用者が Gemini を使える状態か。"""
    return bool(current_gemini_key())


def reconfigure_gemini(api_key: str) -> bool:
    """1人運用で鍵を入れ替えたときに呼ぶ。"""
    global GEMINI_API_KEY, _configured_key
    GEMINI_API_KEY = (api_key or "").strip()
    _configured_key = None          # 次回 configure し直す
    _resolved_model.clear()         # 鍵が変われば使えるモデルも変わる
    return gemini_configured()


# 実際にその鍵で使えると判定したモデル名。鍵ごとに違うので鍵単位で覚える
# （共通の1つに覚えると、別の人の鍵で使えないモデルを掴んでしまう）。
_resolved_model: dict = {}


def _key_id(key: str) -> str:
    """鍵そのものは持たず、区別できる短い指紋だけを持つ。"""
    import hashlib
    return hashlib.sha256((key or "").encode("utf-8")).hexdigest()[:16]


def _list_available_models() -> set:
    """このキーで generateContent が使えるモデル名の集合（テストで差し替え可能）。"""
    import google.generativeai as genai
    out = set()
    for m in genai.list_models():
        methods = getattr(m, "supported_generation_methods", []) or []
        if "generateContent" in methods:
            out.add((m.name or "").replace("models/", ""))
    return out


def _resolve_model(key: str = "") -> str:
    """そのAPIキーで generateContent が使えるモデルを候補から自動選択する。
    list_models() で実際に利用可能なものを見て決める（廃止・新規不可を回避）。
    失敗時は候補の先頭 or "gemini-2.0-flash" にフォールバック。"""
    kid = _key_id(key)
    cached = _resolved_model.get(kid)
    if cached:
        return cached
    usable_candidates = [c for c in _MODEL_CANDIDATES if c not in _model_blacklist]
    fallback = usable_candidates[0] if usable_candidates else "gemini-flash-latest"
    try:
        available = _list_available_models() - _model_blacklist
        # 候補を優先順に、利用可能なら採用
        for cand in usable_candidates:
            if cand in available:
                _resolved_model[kid] = cand
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
            _resolved_model[kid] = best
            return best
        if available:
            _resolved_model[kid] = sorted(available)[0]
            return _resolved_model[kid]
    except Exception:
        pass
    _resolved_model[kid] = fallback
    return fallback


def get_gemini_model(model_name: str | None = None, key: str | None = None,
                     tools=None):
    """GenerativeModel を返す。未設定なら None（絶対にraiseしない）。
    model_name 未指定なら、その鍵で使える最適なモデルを自動選択する。
    鍵をgenaiへ入れるところまで含むので、必ず錠の中から呼ぶこと。

    tools を渡すと、モデルに関数の宣言を持たせる（正式な function calling）。
    これまでは「返答の1行目に目印を書いてくれ」と文章で頼み、その文字列を
    text から探していた。書き忘れ・崩れ・引数のJSON破損が普通に起きるので、
    モデルが正式に備えている口を使う。
    """
    k = key if key is not None else current_gemini_key()
    if not _apply_key(k):
        return None
    try:
        import google.generativeai as genai
        name = model_name or _resolve_model(k)
        if tools:
            return genai.GenerativeModel(name, tools=tools)
        return genai.GenerativeModel(name)
    except Exception:
        return None


def generate_resilient(prompt, stream: bool = False, model_name: str | None = None,
                       tools=None):
    """generate_content の quota-0 429 に強いラッパー。
    使えないモデル（無料枠0）に当たったらブラックリスト→次候補で1度だけ再試行する。
    Gemini未設定なら None。その他の例外はそのまま raise（呼び出し元の整形を維持）。

    鍵の設定と呼び出しは錠でくくる。genai はプロセス全体に1つの鍵しか持てない
    ので、くくらないと別の利用者のリクエストに鍵を差し替えられ、Aさんの鍵で
    Bさんの生成が走ってしまう。
    """
    key = current_gemini_key()
    if not key:
        return None
    with _gemini_lock:
        model = get_gemini_model(model_name, key=key, tools=tools)
        if model is None:
            return None
        try:
            return model.generate_content(prompt, stream=stream)
        except Exception as e:
            if not is_zero_quota_429(e):
                raise
            used = (getattr(model, "model_name", "") or "").replace("models/", "")
            mark_model_unavailable(used)
            model2 = get_gemini_model(model_name, key=key, tools=tools)
            if model2 is None:
                raise
            return model2.generate_content(prompt, stream=stream)


def embed_with_current_key(text: str, model: str):
    """埋め込み。鍵の扱いは生成と同じ（錠でくくる）。"""
    key = current_gemini_key()
    if not key:
        return None
    with _gemini_lock:
        if not _apply_key(key):
            return None
        import google.generativeai as genai
        return genai.embed_content(model=model, content=str(text))


# ── Supabase クライアント（遅延・1度だけ） ───────────────────────
_supabase_client = None
_supabase_tried = False


# ── 利用者ごとのDB差し替え ────────────────────────────────────────
# 各モジュールは get_supabase() 越しにしか Supabase を触らない（83箇所）。
# そこでリクエストの間だけ「その利用者のクライアント」をここに入れておけば、
# 保存先が丸ごとその人のDBに向く。ContextVar なので同時アクセスでも混ざらない。
_request_client: contextvars.ContextVar = contextvars.ContextVar("supabase_request_client", default=None)


def bind_request_client(client) -> object:
    """このリクエストで使うクライアントを差し込む。戻り値は reset 用トークン。

    client=None を渡すと「保存しない（メモリのみ）」になる。未接続の利用者の
    データを、管理者の共有DBへ黙って書かないための明示的な状態。
    """
    return _request_client.set(("set", client))


def reset_request_client(token) -> None:
    try:
        _request_client.reset(token)
    except Exception:
        pass


def storage_is_bound() -> bool:
    """このリクエストに「保存先の差し替え」が入っているか。

    入っていて中身が None なら、その人には保存先が無い。各モジュールは
    そのときメモリへ退避するが、それはプロセスが生きている間だけのもので、
    Renderが再起動すれば消える。保存できたように見えて消えるのが一番きついので、
    呼び出し側（API入口）がここを見て、先に断れるようにする。
    """
    return _request_client.get() is not None


def storage_state() -> str:
    """いまの保存先。"personal" / "server" / "memory" のどれか。

      personal … その人が繋いだSupabase
      server   … サーバー既定のSupabase（持ち主）
      memory   … どこにも残らない（プロセスが死ぬと消える）
    """
    bound = _request_client.get()
    if bound is not None:
        return "personal" if bound[1] is not None else "memory"
    return "server" if get_supabase() is not None else "memory"


def get_supabase():
    """Supabaseクライアントを返す。未設定/失敗時は None（記憶・収益系は空で縮退）。

    リクエストごとの差し替えが入っていれば、そちらを優先する。
    """
    bound = _request_client.get()
    if bound is not None:
        # ("set", client) の形で入っている。client が None なら「保存しない」。
        return bound[1]
    return default_supabase()


def default_supabase():
    """サーバー既定のSupabase。リクエストごとの差し替えを無視する。

    使ってよいのは「差し替える前はどこに入っていたか」を確かめるときだけ。
    普段のデータ操作でこれを呼ぶと、その人のDBではなく共有のDBに触れてしまう。
    """
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
