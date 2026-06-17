import streamlit as st

# 🚨 set_page_config は「最初の Streamlit コマンド」である必要がある（厳格なバージョンでは
#    これより前に他の st.* が走るとクラッシュ）。確実に最上部で実行する。
try:
    from PIL import Image as _PILImage
    _APP_ICON = _PILImage.open("assets/aibou_icon.png")
except Exception:
    _APP_ICON = "❖"
st.set_page_config(page_title="AIbou", page_icon=_APP_ICON, layout="wide")
import google.generativeai as genai
import gspread
from oauth2client.service_account import ServiceAccountCredentials
import pandas as pd
from gtts import gTTS
import base64
import io
import re
from streamlit_mic_recorder import speech_to_text
import pypdf
import os
import json
import hashlib 
import smtplib
from email.mime.text import MIMEText
import random
import requests
# === 新規追加：カレンダー操作用の道具 ===
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
import datetime
import time

# === ☁️ クラウドDB ＆ 暗号化エンジン (Supabase) ===
from supabase import create_client, Client
from cryptography.fernet import Fernet

# === 🔑 Secrets フォールバック（Streamlit Secrets → 環境変数 → .env） ===
# ローカル開発など st.secrets が使えない環境では os.environ / .env を参照する。
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

def get_secret(key, default=""):
    """st.secrets が無い環境では os.environ / .env にフォールバックして値を取得する。"""
    try:
        if key in st.secrets and st.secrets[key] not in (None, ""):
            return st.secrets[key]
    except Exception:
        pass
    return os.environ.get(key, default)

# === 🤖 Agent Engine（マルチAI ＆ ツール実行）を読み込む =====================
# 失敗してもアプリ全体が落ちないよう、フォールバック実装を必ず用意する。
try:
    import agent
    from agent import get_ai_response, run_agent, execute_tool, TOOLS, describe_pending
    AGENT_AVAILABLE = True
except Exception as _agent_err:
    AGENT_AVAILABLE = False

    def get_ai_response(prompt_or_messages, tools=None, model=None, provider=None, purpose=None):
        """フォールバック：Gemini を直接呼ぶだけの簡易版（agent.py 読込失敗時）。"""
        try:
            key = ""
            if purpose:
                try:
                    slot = (st.session_state.get("key_slots", {}) or {}).get(purpose) or {}
                    key = slot.get("key", "")
                except Exception:
                    key = ""
            if not key:
                try:
                    key = st.session_state.get("global_api_keys", {}).get("gemini", "")
                except Exception:
                    pass
            if not key:
                key = get_secret("GEMINI_API_KEY")
            if not key:
                return "⚠️ AIのAPIキーが設定されていません。Settings → Secure Vault で設定してください。"
            genai.configure(api_key=key)
            text = prompt_or_messages if isinstance(prompt_or_messages, str) else \
                "\n".join(m.get("content", "") for m in prompt_or_messages)
            return genai.GenerativeModel(model or "gemini-2.5-flash").generate_content(text).text
        except Exception as e:
            return f"⚠️ AI呼び出しエラー: {e}"

    def run_agent(user_input, chat_history=None):
        chat_history = chat_history or []
        resp = get_ai_response(user_input)
        return resp, chat_history + [
            {"role": "user", "content": user_input},
            {"role": "assistant", "content": resp},
        ], None

    def execute_tool(tool_name, params):
        return "⚠️ エージェント機能が読み込めませんでした。"

    def describe_pending(pending):
        return ""

    TOOLS = []

# === 💰 Income Engine（副業オートメーション：生成＋承認キュー）を読み込む ====
# 失敗してもアプリ全体が落ちないよう、フォールバック実装を必ず用意する。
try:
    import income_engine
    from income_engine import (
        enqueue_theme, list_jobs, get_job, approve_job, approve_all_pending,
        reject_job, reject_and_regenerate, get_stats, update_stats,
        system_status, suggest_theme, generate_metadata,
    )
    INCOME_AVAILABLE = True
except Exception:
    INCOME_AVAILABLE = False

    def enqueue_theme(*a, **k): return None, "⚠️ income_engine を読み込めませんでした。"
    def list_jobs(*a, **k): return []
    def get_job(*a, **k): return None
    def approve_job(*a, **k): return "⚠️ income_engine を読み込めませんでした。"
    def approve_all_pending(*a, **k): return 0
    def reject_job(*a, **k): return "⚠️ income_engine を読み込めませんでした。"
    def reject_and_regenerate(*a, **k): return None, "⚠️ income_engine を読み込めませんでした。"
    def get_stats(*a, **k): return {}
    def update_stats(*a, **k): return False
    def system_status(*a, **k):
        return {"db": False, "ai_engine": False, "ai_key": False,
                "counts": {"pending": 0, "approved": 0, "completed": 0, "failed": 0, "rejected": 0},
                "total": 0}
    def suggest_theme(*a, **k): return ""
    def generate_metadata(*a, **k): return {"error": "income_engine を読み込めませんでした。"}

# === 🎨 Asset Engine（環境音 / サムネイル生成）を読み込む ====================
try:
    import asset_engine
    from asset_engine import generate_ambient_wav, generate_thumbnail, generate_image
    ASSET_AVAILABLE = True
except Exception:
    ASSET_AVAILABLE = False

    def generate_ambient_wav(*a, **k): return None, "⚠️ asset_engine を読み込めませんでした。"
    def generate_thumbnail(*a, **k): return None
    def generate_image(*a, **k): return None, None

# === 🔐 Auth（Supabase Auth）/ 💳 Billing（Stripe）レイヤを読み込む ==========
# 失敗してもアプリを落とさない。AUTH_MODE=supabase のときのみ本物の認証を使う。
try:
    import auth
    AUTH_MODULE = True
except Exception:
    AUTH_MODULE = False
try:
    import billing
    BILLING_AVAILABLE = True
except Exception:
    BILLING_AVAILABLE = False
try:
    import memory as _memory_layer
    MEMORY_LAYER = True
except Exception:
    MEMORY_LAYER = False

try:
    # Auth + RLS を効かせるため、アプリは anon（publishable）キーを優先して使う。
    # headless（GitHub Actions）はサービスロールを使用（scripts 側の設定）。
    supabase: Client = create_client(
        get_secret("SUPABASE_URL"),
        get_secret("SUPABASE_ANON_KEY") or get_secret("SUPABASE_KEY"),
    )
    hasher = hashlib.sha256(get_secret("MASTER_ENCRYPTION_KEY").encode('utf-8')).digest()
    cipher_suite = Fernet(base64.urlsafe_b64encode(hasher))
    DB_CONNECTED = True
except Exception as e:
    DB_CONNECTED = False
    supabase = None

def _vault_uid():
    """Auth有効時のみ current_user の id を返す（per-user vault のキー）。
    legacy/未ログイン時は None（従来のグローバル vault_data id=1 を使う）。"""
    try:
        if 'AUTH_MODULE' in globals() and AUTH_MODULE and auth.enabled(get_secret, supabase if DB_CONNECTED else None):
            return (st.session_state.get("current_user") or {}).get("id")
    except Exception:
        pass
    return None

def log_error(context, err):
    """例外を握り潰さず、共有の診断ログ（st.session_state._error_log）とstderrに記録する。
    Settings → 基本設定 の「🩺 診断ログ」で直近の記録を確認できる。"""
    import sys
    msg = f"{datetime.datetime.now():%H:%M:%S} [{context}] {type(err).__name__}: {err}"
    try:
        if "_error_log" not in st.session_state:
            st.session_state["_error_log"] = []
        log = st.session_state["_error_log"]
        log.append(msg)
        del log[:-50]  # 直近50件だけ保持
    except Exception:
        pass
    print("AIBOU-ERR", msg, file=sys.stderr)

def db_warning():
    """DB未接続時に「保存はこのセッション内のみ」と警告する共通バナー。"""
    if not DB_CONNECTED:
        st.warning("⚠️ データベース未接続：変更はこのセッション内のみ保持され、再読み込みで失われます。"
                   "永続化するには Settings → 🔐 Secure Vault で Supabase の設定をご確認ください。")

def load_vault():
    if not DB_CONNECTED: return {}
    uid = _vault_uid()
    try:
        if uid:
            res = supabase.table("user_vaults").select("encrypted_keys").eq("user_id", uid).limit(1).execute()
        else:
            res = supabase.table("vault_data").select("encrypted_keys").eq("id", 1).execute()
        if res.data and res.data[0].get("encrypted_keys"):
            enc_data = res.data[0]["encrypted_keys"]
            if enc_data == '': return {} # 初期状態
            decrypted = cipher_suite.decrypt(enc_data.encode('utf-8'))
            return json.loads(decrypted.decode('utf-8'))
    except Exception as e:
        log_error("vault.load", e)
        st.error(f"🚨 【DB読み込みエラー】: {e}")
    return {}

def save_vault(data):
    if not DB_CONNECTED: return False
    uid = _vault_uid()
    try:
        encrypted = cipher_suite.encrypt(json.dumps(data).encode('utf-8')).decode('utf-8')
        if uid:
            supabase.table("user_vaults").upsert({"user_id": uid, "encrypted_keys": encrypted}).execute()
        else:
            supabase.table("vault_data").upsert({"id": 1, "encrypted_keys": encrypted}).execute()
        return True
    except Exception as e:
        log_error("vault.save", e)
        st.error(f"🚨 【DB書き込みエラー】: {e}")
        return False

def vault_get(key, default=None):
    """暗号化Vault(Supabase)から1キーを取得する。DB未接続なら default。
    App Archive のアプリ、Document Vault のノート、チャット履歴の永続化に使う。"""
    if not DB_CONNECTED:
        return default
    try:
        return (load_vault() or {}).get(key, default)
    except Exception as e:
        log_error(f"vault_get.{key}", e)
        return default

def persist_vault_key(key, value):
    """暗号化Vault(Supabase)の1キーだけ更新して保存する（他キーは保持）。
    DB未接続時は何もしない（=このセッション内のみ。再起動で消える）。成否を返す。"""
    if not DB_CONNECTED:
        return False
    try:
        v = load_vault() or {}
        v[key] = value
        return save_vault(v)
    except Exception as e:
        log_error(f"persist.{key}", e)
        return False

# === 金庫の鍵をセッションへ読み込む（Auth有効時はログイン後に per-user で実行） ===
def hydrate_vault_into_session(force=False):
    if force or "global_api_keys" not in st.session_state:
        vd = load_vault()
        st.session_state.global_api_keys = vd.get("api_keys", {})
        st.session_state.key_slots = vd.get("key_slots", {})
        st.session_state.user_rules = vd.get("rules", "")  # AIへの常時ルール（CLAUDE rules的）
        st.session_state.custom_ais = vd.get("custom_ais", [])  # STUDIOの自分専用AI（コアから委譲可能に）
        st.session_state.onboarded = vd.get("onboarded", False)  # 初回ガイド表示済みフラグ
    if "key_slots" not in st.session_state:
        st.session_state.key_slots = {}

# === 🧠 全ページ共通のAI会話履歴（ページ移動で文脈が消えないようにする） ===
if "global_chat_history" not in st.session_state:
    st.session_state.global_chat_history = []
# 外部に作用する操作（カレンダー登録・通知）の承認待ちアクション
if "pending_action" not in st.session_state:
    st.session_state.pending_action = None

# === アプリ共通ロゴ（set_page_config は最上部で実行済み） ===
# 画面左上の共通ロゴ（対応バージョンのみ。失敗しても無視）
try:
    st.logo("assets/aibou_icon.png")
except Exception:
    pass

# ==========================================
# 🎨 ログイン背景 ＆ ⚡ ロード(スプラッシュ)画面
#   背景は assets/ の画像を使う。未配置でもCSSフォールバックで成立する。
#     - assets/login_bg.(png|jpg|webp)     … ログイン画面の背景（幾何学ライン）
#     - assets/loading_bg.(gif|png|jpg)     … ロード画面の背景（光のワープ）
# ==========================================
@st.cache_data(show_spinner=False)
def _asset_data_uri(basename, exts):
    """assets/<basename>.<ext> を探して data URI を返す。無ければ ("","")。
    毎回の base64 再エンコードを避けるためキャッシュする（重いGIFで効く）。"""
    _mimes = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
              "gif": "image/gif", "webp": "image/webp"}
    for ext in exts:
        p = f"assets/{basename}.{ext}"
        if os.path.exists(p):
            try:
                with open(p, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()
                return f"data:{_mimes.get(ext, 'image/png')};base64,{b64}", ext
            except Exception:
                pass
    return "", ""


def inject_login_background():
    uri, _ = _asset_data_uri("login_bg", ["gif", "png", "jpg", "jpeg", "webp"])
    layer = (f"#000 url('{uri}') center/cover no-repeat"
             if uri else "radial-gradient(circle at 50% 38%, #14161d 0%, #000 72%)")
    st.markdown(f"""
    <style>
    .stApp {{ background:#000 !important; }}
    [data-testid="stHeader"] {{ background: transparent !important; }}
    /* 背景は擬似要素に。ぼかし＋暗幕で低解像度のザラつきを抑え、文字を読みやすく */
    .stApp::before {{
        content:""; position:fixed; inset:-40px; z-index:0;
        background: {layer};
        filter: blur(5px) brightness(0.5) saturate(1.05);
        transform: scale(1.08); }}
    [data-testid="stAppViewContainer"] {{ position:relative; z-index:1; background:transparent !important; }}
    .block-container {{ max-width: 700px !important; padding-top: 8vh !important; }}
    /* 中央のガラスカード（st.container(border=True)） */
    [data-testid="stVerticalBlockBorderWrapper"] {{
        background: rgba(12,14,20,0.55) !important; backdrop-filter: blur(16px) !important;
        border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 20px !important;
        box-shadow: 0 20px 60px rgba(0,0,0,0.6) !important; padding: 22px 26px !important; }}
    .login-title {{ text-align:center; color:#fff; font-weight:800; letter-spacing:4px;
        font-size:24px; margin:10px 0 2px; text-shadow:0 0 18px rgba(255,255,255,.35); }}
    .login-sub {{ text-align:center; color:#aab0b8; letter-spacing:3px; font-size:12px; margin-bottom:18px; }}
    .stApp p, .stApp label, [data-baseweb="tab"] {{ color:#eef2f6 !important; }}
    [data-baseweb="tab-list"] {{ justify-content:center; }}
    [data-testid="stTextInput"] input {{
        background: rgba(255,255,255,0.07) !important; color:#fff !important;
        border:1px solid rgba(255,255,255,0.3) !important; border-radius:12px !important; }}
    [data-testid="stTextInput"] input:focus {{
        border-color:#fff !important; box-shadow:0 0 14px rgba(255,255,255,0.35) !important; }}
    .stButton > button, .stFormSubmitButton > button {{
        background: rgba(255,255,255,0.10) !important; color:#fff !important;
        border:1px solid rgba(255,255,255,0.6) !important; border-radius:12px !important;
        letter-spacing:2px !important; font-weight:700 !important; transition:all .2s ease; }}
    .stButton > button:hover, .stFormSubmitButton > button:hover {{
        background: rgba(255,255,255,0.2) !important; box-shadow:0 0 18px rgba(255,255,255,0.4) !important; }}
    [data-testid="stCheckbox"] * {{ color:#cfd6dd !important; }}
    </style>
    """, unsafe_allow_html=True)


def render_loading_overlay(duration=4.5):
    """ログイン直後に全画面スプラッシュを「同期描画」し、その裏で本ランがメインを構築する。
    CSSアニメで duration 秒後に自動フェード（opacity0+visibility:hidden＝クリック透過）。
    重いGIFは JS(components) で表示後に DOM 除去し、残存ラグを防ぐ。"""
    uri, _ = _asset_data_uri("loading_bg", ["gif", "png", "jpg", "jpeg", "webp"])
    bg_css = (f"#000 url('{uri}') center/cover no-repeat"
              if uri else "radial-gradient(circle at 50% 50%, #1b1d26 0%, #000 70%)")
    d = float(duration)
    total = d + 0.6
    hold = int(d / total * 100)
    st.markdown(f"""
    <style>
    #forge-splash-ov {{ position:fixed; inset:0; z-index:2147483600; background:{bg_css};
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        font-family:'Share Tech Mono',monospace; animation: fov-life {total:.2f}s ease forwards; }}
    @keyframes fov-life {{ 0%{{opacity:0; transform:scale(1.1)}} 6%{{opacity:1; transform:scale(1)}}
        {hold}%{{opacity:1; visibility:visible}} 100%{{opacity:0; visibility:hidden}} }}
    #forge-splash-ov::after {{ content:""; position:absolute; inset:0; background:rgba(0,0,0,.42); }}
    #forge-splash-ov > * {{ position:relative; z-index:1; }}
    #forge-splash-ov .ttl {{ color:#fff; letter-spacing:14px; font-weight:800; font-size:26px;
        text-shadow:0 0 22px rgba(255,255,255,.7); }}
    #forge-splash-ov .sub {{ color:#cfd6dd; letter-spacing:7px; font-size:11px; margin-top:12px; }}
    #forge-splash-ov .log {{ margin-top:22px; min-height:94px; font-size:12px; color:#9fe7ff;
        letter-spacing:2px; text-align:left; }}
    #forge-splash-ov .log div {{ opacity:0; animation: flog .5s ease forwards; }}
    @keyframes flog {{ to {{ opacity:1; }} }}
    #forge-splash-ov .bar {{ width:260px; height:3px; margin-top:18px; background:rgba(255,255,255,.15);
        border-radius:3px; overflow:hidden; }}
    #forge-splash-ov .bar > i {{ display:block; height:100%; width:0; background:#fff;
        box-shadow:0 0 14px #fff; animation: fbar {d:.2f}s ease-in-out forwards; }}
    @keyframes fbar {{ to {{ width:100%; }} }}
    </style>
    <div id="forge-splash-ov">
        <div class="ttl">THE FORGE OS</div>
        <div class="sub">SYSTEM BOOTING…</div>
        <div class="log">
            <div style="animation-delay:.3s">&#9656; AUTH SESSION ............ OK</div>
            <div style="animation-delay:{d*0.32:.2f}s">&#9656; SECURE VAULT ........... LOADED</div>
            <div style="animation-delay:{d*0.55:.2f}s">&#9656; AI CORE ................ ONLINE</div>
            <div style="animation-delay:{d*0.78:.2f}s">&#9656; WORKSPACE SYNC ......... DONE</div>
        </div>
        <div class="bar"><i></i></div>
    </div>
    """, unsafe_allow_html=True)
    # ※ JS無し。CSSアニメ(fov-life)が duration 後に opacity:0 + visibility:hidden で
    #    自動的に隠す（クリック透過）。components.html(JS)は安定性のため使わない。


# ==========================================
# 🔐 1. 認証（Supabase Auth または 従来の共有パスワード）
# ==========================================
if "logged_in" not in st.session_state:
    st.session_state.logged_in = False

# AUTH_MODE=supabase かつ DB接続時のみ本物の認証。それ以外は従来パスワードへフォールバック。
AUTH_ON = False
try:
    AUTH_ON = ('AUTH_MODULE' in globals() and AUTH_MODULE
               and auth.enabled(get_secret, supabase if DB_CONNECTED else None))
except Exception:
    AUTH_ON = False

if AUTH_ON:
    _cu = None
    try:
        _cu = auth.restore_session(supabase)
    except Exception:
        _cu = None
    if not _cu:
        inject_login_background()
        auth.render_login(supabase, get_secret)
        st.stop()
    # Stripe 決済からの復帰（?checkout=success）を検証して購読を反映
    if BILLING_AVAILABLE:
        try:
            _bm = billing.handle_return(supabase, get_secret, auth.current_user())
            if _bm:
                st.session_state["_billing_msg"] = _bm
        except Exception:
            pass
else:
    if not st.session_state.logged_in:
        inject_login_background()
        _ico, _ = _asset_data_uri("aibou_icon", ["png"])
        with st.container(border=True):
            if _ico:
                st.markdown(
                    f"<div style='text-align:center'><img src='{_ico}' width='92' "
                    f"style='filter:drop-shadow(0 0 12px rgba(255,255,255,.45))'></div>",
                    unsafe_allow_html=True)
            st.markdown("<div class='login-title'>相棒AI</div>"
                        "<div class='login-sub'>起動シークエンス</div>", unsafe_allow_html=True)
            password = st.text_input("Password", type="password",
                                     label_visibility="collapsed", placeholder="パスワードを入力")
            if st.button("システム起動", use_container_width=True):
                if password == st.secrets.get("APP_PASSWORD", "boss"):
                    st.session_state.logged_in = True
                    st.session_state.show_loading = True
                    st.rerun()
                else:
                    st.error("パスワードが違います。")
        st.stop()

# ログイン後：金庫(APIキー)をセッションへ読み込む（Auth有効時は per-user）
hydrate_vault_into_session()

# 決済などの一度きりメッセージ
_bm = st.session_state.pop("_billing_msg", None)
if _bm:
    try:
        st.toast(_bm)
    except Exception:
        st.info(_bm)

# === ⚡ ロード画面：スプラッシュを前面に出し、その「裏」で本ランがメインを構築する ===
#   st.rerun / st.stop は使わない。下のルーティングが同一ラン内でHUBを完成させ、
#   スプラッシュは約4.5秒後に自動フェード＆DOM除去 → 完成済みのメインが滑らかに現れる。
if st.session_state.pop("show_loading", False):
    render_loading_overlay(duration=4.5)

# ==========================================
# 🧭 2. THE AIbou OS セントラルルーティング
# ==========================================
if "current_mode" not in st.session_state:
    st.session_state.current_mode = "HUB"

# 部屋カード（HUBのホワイトグラスカード）からの遷移：?goto=<mode>
try:
    _goto = st.query_params.get("goto")
    if _goto:
        st.session_state.current_mode = _goto
        try:
            del st.query_params["goto"]
        except Exception:
            st.query_params.clear()
        st.rerun()
except Exception:
    pass

# ==========================================
# 🧭 モード定義（HUBカルーセル＆サイドバーで共用する単一の定義元）
# rooms: (表示名, サブラベル, 遷移先 current_mode)。CORE は対話モード（rooms無し）。
# ==========================================
FORGE_MODES = [
    {"name": "CORE", "icon": "❖", "desc": "メイン司令塔 — コアと対話する（何でも相談・指示）。", "rooms": []},
    {"name": "FACTORY", "icon": "⚒", "desc": "アプリの錬成とプロトタイプの保管。",
     "rooms": [("Forge Lab", "FORGE LAB", "Forge Lab"), ("App Archive", "APP ARCHIVE", "App Archive")]},
    {"name": "AGENCY", "icon": "✦", "desc": "タスクの実行管理と履歴。",
     "rooms": [("Active Tasks", "ACTIVE TASKS", "Active Tasks"), ("Task History", "TASK HISTORY", "Task History")]},
    {"name": "INCOME", "icon": "💰", "desc": "副業オートメーション（自動収益化）。",
     "rooms": [("Auto Income", "AUTO INCOME", "Auto Income")]},
    {"name": "BRAIN", "icon": "◈", "desc": "知識の保管とアイデアの可視化。",
     "rooms": [("Data Vault", "DATA VAULT", "Document Vault"), ("Miro Board", "MIRO BOARD", "Dashboard")]},
    {"name": "STUDIO", "icon": "🎨", "desc": "自分専用AIを作る（Dify風）。人格・APIを設定して育てる。",
     "rooms": [("AI Studio", "AI STUDIO", "AI Studio")]},
    {"name": "SYSTEM", "icon": "⚙", "desc": "システムの進化と環境設定。",
     "rooms": [("Evolution", "EVOLUTION", "Core Upgrade"), ("Settings", "SETTINGS", "Settings")]},
]

# 各部屋の日本語ひとこと説明（ガイド／ツールチップ用）
ROOM_JP = {
    "Forge Lab": "アプリ/画像/動画/スライドをAIで生成",
    "App Archive": "生成したミニアプリの保管・起動",
    "Active Tasks": "実行中タスクの管理・確認待ち対応",
    "Task History": "完了タスクのアーカイブ",
    "Auto Income": "副業の自動化（テーマ→生成→承認）",
    "Document Vault": "資料・メモの保管と検索",
    "Dashboard": "アイデアボード(Miro)＆システム監視",
    "AI Studio": "自分専用AIの作成＋ワークフロー自動化",
    "Core Upgrade": "自己進化（オーナー専用）",
    "Settings": "APIキー・ルール・ユーザー管理",
}

# 部屋に入った直後にヘッダー下へ出す日本語の説明（新規ユーザーが迷わないように）
ROOM_GUIDE = {
    "Forge Lab": "AIにアプリ・画像・動画・スライドを作らせる制作室。種類を選び、作りたい内容を書いて生成します。",
    "App Archive": "生成したミニアプリの保管庫。カードから起動・再編集・削除ができます。",
    "Active Tasks": "実行中タスクの管理室。確認待ち（要承認）のタスクをここで承認／却下します。",
    "Task History": "完了したタスクの履歴。過去の実行結果を振り返れます。",
    "Auto Income": "副業の自動化ライン。テーマを入れると「生成→下書き→あなたの承認」の順で進みます。",
    "Document Vault": "資料・メモの保管庫。保存した内容をあとからAIが参照・検索します。",
    "Dashboard": "アイデアボード（Miro）とシステム監視。思考の整理と全体状態の確認に。",
    "AI Studio": "自分専用AIを作る工房。人格・口調・ルール・APIを設定し、コアから呼び出せます。",
    "Core Upgrade": "コア自身を進化させるオーナー専用室。操作は慎重に行ってください。",
    "Settings": "APIキー・常時ルール・ユーザー管理などの全体設定。まずはGeminiキーの登録を。",
}

def room_help(target):
    """部屋のヘッダー直下に出す日本語の簡単な説明（新規ユーザー向け）。"""
    _t = ROOM_GUIDE.get(target)
    if _t:
        st.caption(f"ℹ️ {_t}")

if st.session_state.current_mode == "HUB":
    st.markdown("""
        <style>
        [data-testid="collapsedControl"] { display: none !important; }
        [data-testid="stSidebar"] { display: none !important; }
        </style>
    """, unsafe_allow_html=True)
    page = "HUB"
else:
    st.sidebar.markdown("<h2 style='text-align:center; color:var(--fg-strong); font-weight:900; letter-spacing:3px; margin-bottom: 16px;'>THE FORGE</h2>", unsafe_allow_html=True)
    if st.sidebar.button("⬅️ RETURN TO HUB", use_container_width=True):
        st.session_state.current_mode = "HUB"
        st.rerun()
    st.sidebar.markdown("---")

    # 📁 フォルダ(モード) / 📄 ファイル(各部屋) のツリー表示（権限で出し分け）
    st.sidebar.caption("MODES")
    _cur = st.session_state.current_mode
    _is_owner = (not AUTH_ON) or auth.is_owner()
    _income_ok = (not AUTH_ON) or auth.income_active()
    for _m in FORGE_MODES:
        if not _m["rooms"]:
            continue  # CORE（対話モード）はページが無いので RETURN TO HUB に集約
        # 自己進化（Core Upgrade）は owner 専用 → 非ownerには出さない
        _rooms = [r for r in _m["rooms"] if not (r[2] == "Core Upgrade" and not _is_owner)]
        if not _rooms:
            continue
        _targets = [t for _, _, t in _rooms]
        with st.sidebar.expander(f"📁 {_m.get('icon', '')} {_m['name']}", expanded=(_cur in _targets)):
            for _disp, _sub, _target in _rooms:
                _lock = (_target == "Auto Income" and not _income_ok)
                _icon = ("● " if _target == _cur else ("🔒 " if _lock else "📄 "))
                if st.button(_icon + _disp, key=f"side_{_target}", use_container_width=True,
                             help=ROOM_JP.get(_target)):
                    st.session_state.current_mode = _target
                    st.rerun()

    st.sidebar.markdown("---")
    if st.sidebar.button("🚪 Logout", use_container_width=True):
        if AUTH_ON:
            auth.sign_out(supabase)
        else:
            st.session_state.logged_in = False
        st.rerun()

    page = st.session_state.current_mode

@st.cache_data(show_spinner=False)
def get_base64_video(file_path):
    if not os.path.exists(file_path): return None
    try:
        with open(file_path, "rb") as f:
            return base64.b64encode(f.read()).decode()
    except Exception: return None

video_base64 = get_base64_video("bg.mp4")

if video_base64:
    st.markdown("""
        <style>
        /* 1. 全体の背景（白・微グレー）とサイドバーの枠線完全除去 */
        .stApp, [data-testid="stAppViewContainer"], [data-testid="stHeader"] { background-color: #e0e5ec !important; background-image: none !important; }
        [data-testid="stSidebar"], [data-testid="stSidebar"] > div:first-child { background-color: #e0e5ec !important; border-right: none !important; box-shadow: none !important; }
        .stApp, p, span, div { color: #2d3748 !important; }
        [data-testid="stBottom"], [data-testid="stBottom"] > div { background: transparent !important; }
        [data-testid="stSidebar"] h1, [data-testid="stSidebar"] label { color: #1a202c !important; text-shadow: none !important; font-weight: 800 !important; letter-spacing: 2px !important; }
        [data-testid="stSidebar"] [data-testid="stExpander"] { border: none !important; background: transparent !important; box-shadow: none !important; }
        [data-testid="stSidebar"] [data-testid="stExpander"] summary p { color: #1a202c !important; font-weight: 800 !important; letter-spacing: 2px !important; font-size: 14px !important; }
        
        /* 2. 【ボタン全体】クリアで3Dなボタンベース */
        div[role="radiogroup"] { gap: 15px; padding: 10px; }
        div[role="radiogroup"] > label { background: rgba(255, 255, 255, 0.6) !important; backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.8) !important; border-radius: 15px !important; padding: 10px 20px !important; box-shadow: 6px 6px 12px rgba(163, 177, 198, 0.5), -6px -6px 12px rgba(255, 255, 255, 0.9) !important; transition: all 0.2s ease-in-out; cursor: pointer; }
        div[role="radiogroup"] > label p { color: #1a202c !important; font-weight: bold !important; }
        div[role="radiogroup"] > label[data-checked="true"] { box-shadow: inset 4px 4px 8px rgba(163, 177, 198, 0.6), inset -4px -4px 8px rgba(255, 255, 255, 0.9) !important; border: 1px solid #00f3ff !important; }
        div[role="radiogroup"] > label[data-checked="true"] p { color: #1a202c !important; text-shadow: none !important; }
        div[role="radiogroup"] > label[data-checked="true"] span[data-baseweb="radio"] > div { background-color: #00f3ff !important; }
        div[role="radiogroup"] > label[data-checked="true"] span[data-baseweb="radio"] > div > div { background-color: #00f3ff !important; }
        
        /* 🚨 3. 【すべての入力欄】スマホののっぺり化を解除し、3Dガラスエフェクトを適用 */
        [data-testid="stChatInput"], 
        [data-testid="stTextArea"] textarea, 
        [data-testid="stTextInput"] input { 
            -webkit-appearance: none !important; /* スマホの標準デザインを強制解除 */
            appearance: none !important;
            background: rgba(255, 255, 255, 0.5) !important; 
            backdrop-filter: blur(15px); 
            border: 1px solid rgba(255, 255, 255, 0.9) !important; 
            border-radius: 20px !important; 
            box-shadow: 10px 10px 20px rgba(163, 177, 198, 0.6), -10px -10px 20px rgba(255, 255, 255, 1), inset 2px 2px 5px rgba(255, 255, 255, 0.6) !important; 
            padding: 10px 15px !important; 
            color: #2b6cb0 !important; 
            font-weight: bold; 
            font-family: 'Share Tech Mono', sans-serif; 
            transition: all 0.2s ease-in-out; 
        }
        
        /* 入力中（フォーカス時）は水色に発光 */
        [data-testid="stChatInput"]:focus-within, 
        [data-testid="stTextArea"] textarea:focus, 
        [data-testid="stTextInput"] input:focus { 
            border-color: #00f3ff !important; 
            box-shadow: inset 2px 2px 5px rgba(255, 255, 255, 0.6), 0 0 15px rgba(0, 243, 255, 0.5) !important; 
            outline: none !important; 
        }
        
        /* 4. チャットの吹き出し */
        [data-testid="stChatMessage"] { background: rgba(255, 255, 255, 0.4) !important; backdrop-filter: blur(8px); border: 1px solid rgba(255, 255, 255, 0.8) !important; border-radius: 15px !important; box-shadow: 5px 5px 10px rgba(163, 177, 198, 0.3), -5px -5px 10px rgba(255, 255, 255, 0.8); }
        [data-testid="stChatMessage"] p, [data-testid="stChatMessage"] div { color: #1a202c !important; }
        .stChatFloatingInputContainer { box-shadow: none !important; }
        </style>
    """, unsafe_allow_html=True)

# （Logout はサブページのサイドバー内に移動。HUBではサイドバー自体を生成しない）

# ==========================================
# 🧠 3. バックグラウンド接続 (Fail-Safe 実装済)
# ==========================================
_boot_gemini_key = get_secret("GEMINI_API_KEY")
if _boot_gemini_key:
    genai.configure(api_key=_boot_gemini_key)

# 🚨 新機能：スプレッドシートがエラーの時にアプリを落とさない「ダミー生成器」
class DummySheet:
    def get_all_values(self):
        return [
            ['タスクID', '目標', 'タスク内容', 'ステータス', 'ログ', 'ボスの回答'],
            ['ERR-001', 'System', '⚠️ スプレッドシート連携エラー（SecretsのGOOGLE_CREDENTIALSの記述が崩れています）', '未着手', '設定を確認してください。', '']
        ]
    def update_cell(self, row, col, val):
        pass

@st.cache_resource
def get_sheet():
    scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
    if "GOOGLE_CREDENTIALS" in st.secrets and st.secrets["GOOGLE_CREDENTIALS"].strip():
        creds_dict = json.loads(st.secrets["GOOGLE_CREDENTIALS"])
        creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, scope)
    elif os.path.exists('credentials.json'):
        creds = ServiceAccountCredentials.from_json_keyfile_name('credentials.json', scope)
    else:
        return DummySheet()
    client = gspread.authorize(creds)
    return client.open("AibouAgent").worksheet("Agent_Brain")

try:
    sheet = get_sheet()
except Exception as e:
    sheet = DummySheet()
    st.sidebar.error("⚠️ スプレッドシート接続エラー：一部機能が制限されています。")


# 🚨【超重要】AI Console と Forge Lab のコアを完全に共通化する設計図
MASTER_CORE_TEMPLATE = """
<style>
    #core-settings { 
        display: none; position: absolute; 
        left: 50%; top: 50%; transform: translate(-50%, -50%); 
        background: rgba(10, 10, 16, 0.92); backdrop-filter: blur(15px); border: 1px solid #2a2a34;
        border-radius: 20px; padding: 20px; box-shadow: 0px 10px 30px rgba(0, 0, 0, 0.6);
        width: 280px; max-height: 90%; overflow-y: auto; z-index: 99999;
        font-family: 'Segoe UI', sans-serif; color: #e6e8ec; font-size: 12px;
    }
    #core-settings input[type=range] { accent-color: #00f3ff; cursor: pointer; width: 100%; }
    #core-settings select { background: rgba(255,255,255,0.06); color:#e6e8ec; border: 1px solid #2a2a34; border-radius: 8px; padding: 5px; outline: none; width: 100%; cursor: pointer; }
    #core-settings input[type=color] { border: none; background: transparent; cursor: pointer; width: 30px; height: 30px; padding: 0; }
    #core-settings button:hover { filter: brightness(1.1); }
</style>

<div id="core-wrapper" style="position:relative; width:100%; height:H_VALpx; display:flex; justify-content:center; align-items:center;">
    <div id="core-container" style="cursor:pointer; display:flex; flex-direction:column; align-items:center; z-index:10; width:100%;">
        <canvas id="visualizer" width="280" height="280" style="filter:drop-shadow(0 8px 20px rgba(0, 150, 255, 0.3));"></canvas>
        <div id="status-info" style="margin-top:10px; font-size:11px; letter-spacing:6px; color:#3182ce; font-family:monospace; font-weight:bold;">SYSTEM ONLINE</div>
    </div>

    <div id="core-settings">
        <h4 style="margin:0 0 15px 0; color:#ffffff; text-align:center; font-weight:800; letter-spacing:2px;">A.I. SETTINGS</h4>
        <div style="margin-bottom: 12px;"><label style="font-weight:bold; display:block; margin-bottom:2px;">Voice Speed: <span id="val-speed">1.5</span>x</label><input type="range" id="ctrl-speed" min="0.5" max="2.0" step="0.1" value="1.5"></div>
        <div style="margin-bottom: 12px;"><label style="font-weight:bold; display:block; margin-bottom:2px;">Volume: <span id="val-vol">100</span>%</label><input type="range" id="ctrl-vol" min="0" max="1" step="0.05" value="1"></div>
        <label style="display:block; margin-bottom:12px; font-weight:bold; cursor:pointer;"><input type="checkbox" id="ctrl-filter"> Sci-Fi Voice Filter</label>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;"><label style="font-weight:bold;">Inner Core Color:</label><input type="color" id="ctrl-inner-color"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;"><label style="font-weight:bold;">Outer Ring Color:</label><input type="color" id="ctrl-outer-color"></div>
        <div style="margin-bottom: 12px;"><label style="font-weight:bold; display:block; margin-bottom:2px;">Pulse Mode:</label><select id="ctrl-pulse"><option value="1">Relax</option><option value="2">Active</option><option value="4">Overdrive</option></select></div>
        <label style="display:block; margin-bottom:15px; font-weight:bold; cursor:pointer;"><input type="checkbox" id="ctrl-particles"> Hologram Particles</label>
        
        <div style="border-top: 1px solid rgba(0,0,0,0.1); padding-top: 10px; margin-bottom: 15px;">
            <label style="display:block; font-weight:bold; color:#00f3ff; cursor:pointer; text-shadow: 0 0 5px rgba(0,243,255,0.3); margin-bottom: 8px;">
                <input type="checkbox" id="ctrl-mic"> 🎙️ Enable Voice Command
            </label>
            <label style="display:block; font-weight:bold; color:#2b6cb0; cursor:pointer;">
                <input type="checkbox" id="ctrl-chat"> 💬 Show Chat Interface
            </label>
        </div>
        
        <button id="ctrl-zen" style="width:100%; padding:8px; background:#1a202c; color:white; border-radius:10px; border:none; cursor:pointer; font-weight:bold; margin-bottom:8px;">Activate Zen Protocol</button>
        <button id="ctrl-reset" style="width:100%; padding:8px; background:transparent; color:#e53e3e; border:1px solid #e53e3e; border-radius:10px; cursor:pointer; font-weight:bold;">Reset to Default</button>
        <div style="text-align:center; margin-top:10px;"><a href="#" id="close-settings" style="color:#2b6cb0; text-decoration:none; font-weight:bold;">[ Close Panel ]</a></div>
    </div>
</div>

<audio id="ai-voice" A_PLAY><source src="data:audio/mp3;base64,V_DATA" type="audio/mp3"></audio>

<script>
    const coreContainer = document.getElementById("core-container");
    const settingsPanel = document.getElementById("core-settings");
    const closeBtn = document.getElementById("close-settings");
    const audio = document.getElementById("ai-voice");
    const canvas = document.getElementById("visualizer");
    const ctx = canvas.getContext("2d");
    const statusText = document.getElementById("status-info");

    const STORAGE_KEY = "jarvis_core_settings";
    // 🚨 showChat をデフォルト設定に追加
    const DEFAULTS = { speed: 1.5, vol: 1, filter: false, innerColor: "#66FCF1", outerColor: "#45A29E", pulse: 2, particles: false, showMic: false, showChat: true };
    
    let settings = { ...DEFAULTS };
    try { 
        let saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved && typeof saved === 'object') { settings = { ...DEFAULTS, ...saved }; }
    } catch(e) {}

    try {
        document.getElementById("ctrl-speed").value = settings.speed;
        document.getElementById("val-speed").innerText = settings.speed; audio.playbackRate = settings.speed;
        document.getElementById("ctrl-vol").value = settings.vol;
        document.getElementById("val-vol").innerText = Math.round(settings.vol * 100); audio.volume = settings.vol;
        document.getElementById("ctrl-filter").checked = settings.filter;
        document.getElementById("ctrl-inner-color").value = settings.innerColor;
        document.getElementById("ctrl-outer-color").value = settings.outerColor;
        document.getElementById("ctrl-pulse").value = settings.pulse;
        document.getElementById("ctrl-particles").checked = settings.particles;
        document.getElementById("ctrl-mic").checked = settings.showMic;
        document.getElementById("ctrl-chat").checked = settings.showChat; // 🚨UI反映
        statusText.style.color = settings.innerColor;
    } catch(e) { console.error(e); }

    function updateMicVisibility(isVisible) {
        try {
            const parentDoc = window.parent.document;
            let styleEl = parentDoc.getElementById("mic-visibility-style");
            if(!styleEl) { styleEl = parentDoc.createElement("style"); styleEl.id = "mic-visibility-style"; parentDoc.head.appendChild(styleEl); }
            if(isVisible) { styleEl.innerHTML = ``; } 
            else { styleEl.innerHTML = `[data-testid="stVerticalBlock"] > div:has(iframe[title*="streamlit_mic_recorder"]) { display: none !important; height: 0px !important; margin: 0 !important; overflow: hidden !important; }`; }
        } catch(e) {}
    }
    updateMicVisibility(settings.showMic);

    // 🚨 チャット欄の表示/非表示をコントロールするCSSを注入
    function updateChatVisibility(isVisible) {
        try {
            const parentDoc = window.parent.document;
            let styleEl = parentDoc.getElementById("chat-visibility-style");
            if(!styleEl) { styleEl = parentDoc.createElement("style"); styleEl.id = "chat-visibility-style"; parentDoc.head.appendChild(styleEl); }
            if(isVisible) { styleEl.innerHTML = ``; } 
            else { styleEl.innerHTML = `[data-testid="stChatInput"], [data-testid="stChatMessage"] { display: none !important; }`; }
        } catch(e) {}
    }
    updateChatVisibility(settings.showChat);

    function saveSettings() {
        settings.speed = parseFloat(document.getElementById("ctrl-speed").value) || 1.5;
        settings.vol = parseFloat(document.getElementById("ctrl-vol").value) || 1;
        settings.filter = document.getElementById("ctrl-filter").checked;
        settings.innerColor = document.getElementById("ctrl-inner-color").value;
        settings.outerColor = document.getElementById("ctrl-outer-color").value;
        settings.pulse = parseFloat(document.getElementById("ctrl-pulse").value) || 2;
        settings.particles = document.getElementById("ctrl-particles").checked;
        settings.showMic = document.getElementById("ctrl-mic").checked;
        settings.showChat = document.getElementById("ctrl-chat").checked; // 🚨保存
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }

    coreContainer.onclick = () => { settingsPanel.style.display = "block"; };
    closeBtn.onclick = (e) => { e.preventDefault(); settingsPanel.style.display = "none"; };

    document.getElementById("ctrl-speed").oninput = (e) => { document.getElementById("val-speed").innerText = e.target.value; audio.playbackRate = e.target.value; saveSettings(); };
    document.getElementById("ctrl-vol").oninput = (e) => { document.getElementById("val-vol").innerText = Math.round(e.target.value * 100); audio.volume = e.target.value; saveSettings(); };
    document.getElementById("ctrl-inner-color").oninput = (e) => { settings.innerColor = e.target.value; statusText.style.color = settings.innerColor; saveSettings(); };
    document.getElementById("ctrl-outer-color").oninput = (e) => { settings.outerColor = e.target.value; saveSettings(); };
    document.getElementById("ctrl-pulse").onchange = (e) => { settings.pulse = parseFloat(e.target.value); saveSettings(); };
    document.getElementById("ctrl-particles").onchange = (e) => { settings.particles = e.target.checked; saveSettings(); };
    document.getElementById("ctrl-mic").onchange = (e) => { settings.showMic = e.target.checked; saveSettings(); updateMicVisibility(settings.showMic); };
    document.getElementById("ctrl-chat").onchange = (e) => { settings.showChat = e.target.checked; saveSettings(); updateChatVisibility(settings.showChat); }; // 🚨イベント追加
    
    let isZenMode = false;
    document.getElementById("ctrl-zen").onclick = () => {
        try {
            const parentDoc = window.parent.document; isZenMode = !isZenMode; let btn = document.getElementById("ctrl-zen");
            if(isZenMode) { btn.innerText = "Deactivate Zen Protocol"; btn.style.background = "#e53e3e"; if(!parentDoc.getElementById("zen-style")) { const style = parentDoc.createElement("style"); style.id = "zen-style"; style.innerHTML = `[data-testid="stSidebar"], [data-testid="stChatInput"], [data-testid="stChatMessage"] { display: none !important; transition: all 0.5s; } .stApp { background-color: #ffffff !important; }`; parentDoc.head.appendChild(style); } } 
            else { btn.innerText = "Activate Zen Protocol"; btn.style.background = "#1a202c"; const style = parentDoc.getElementById("zen-style"); if(style) style.remove(); }
        } catch(e) {}
    };

    document.getElementById("ctrl-reset").onclick = () => { localStorage.removeItem(STORAGE_KEY); location.reload(); };

    let audioCtx, analyser, source, biquadFilter, dataArray, smoothedData, isSetup = false;
    function setup() { 
        if (isSetup || !audio.src.includes("base64")) return; 
        try { 
            audioCtx = new (window.AudioContext || window.webkitAudioContext)(); analyser = audioCtx.createAnalyser(); analyser.fftSize = 128; 
            biquadFilter = audioCtx.createBiquadFilter(); biquadFilter.type = "bandpass"; biquadFilter.frequency.value = 1500; biquadFilter.Q.value = 1.5; 
            source = audioCtx.createMediaElementSource(audio); 
            if(settings.filter) { source.connect(biquadFilter); biquadFilter.connect(analyser); } else { source.connect(analyser); } 
            analyser.connect(audioCtx.destination); 
            dataArray = new Uint8Array(analyser.frequencyBinCount); smoothedData = new Float32Array(analyser.frequencyBinCount); 
            isSetup = true; 
        } catch(e) {} 
    }
    
    function hexToRgb(hex) { let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : "0, 243, 255"; }
    
    let particles = [];
    let _lastFrame = 0;
    const _FRAME_MS = 1000 / 30; // FPS上限(30fps)で省電力
    function draw(now) {
        requestAnimationFrame(draw);
        if (document.hidden) return;                 // タブ非表示中は描画しない（CPU節約）
        now = now || performance.now();
        if (now - _lastFrame < _FRAME_MS) return;    // FPS上限で間引き
        _lastFrame = now;
        const cx = canvas.width/2, cy = canvas.height/2; ctx.clearRect(0,0,canvas.width,canvas.height);
        let avg = 0; let time = Date.now() / 1000; 
        
        if(isSetup && !audio.paused) { 
            analyser.getByteFrequencyData(dataArray); 
            for(let i=0; i<30; i++) { smoothedData[i] += (dataArray[i]-smoothedData[i])*0.25; avg += smoothedData[i]; } 
            avg /= 30; 
        } else { 
            avg = 15 + Math.sin(time * settings.pulse) * 8; 
        } 
        
        let rgbInner = hexToRgb(settings.innerColor); let rgbOuter = hexToRgb(settings.outerColor); 
        let r = 55 + avg * 0.9; 
        
        let g = ctx.createRadialGradient(cx,cy,0,cx,cy,r); 
        g.addColorStop(0,"rgba(255,255,255,1)"); g.addColorStop(0.4, `rgba(${rgbInner}, 0.8)`); g.addColorStop(1,"transparent"); 
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill(); 
        
        for(let j=0; j<2; j++) { 
            ctx.beginPath(); let rot = (j==0 ? time : -time * 0.7); let baseR = 75 + (j*15); 
            for(let i=0; i<=60; i++) { 
                let a = (i/60)*Math.PI*2 + rot; let dIdx = i <= 30 ? i : 60 - i; 
                let wave = (isSetup && !audio.paused) ? smoothedData[dIdx % 30]*0.5 : Math.sin(time * settings.pulse * 2 + i/5)*3; 
                let x = cx + Math.cos(a)*(baseR + wave), y = cy + Math.sin(a)*(baseR + wave); 
                if(i==0) ctx.moveTo(x,y); else ctx.lineTo(x,y); 
            } 
            ctx.strokeStyle = j==0 ? `rgba(${rgbOuter}, 0.9)` : `rgba(${rgbOuter}, 0.4)`; ctx.lineWidth = j==0 ? 2 : 1.5; ctx.stroke(); 
        } 
        
        if (settings.particles) { 
            if(particles.length < 30) particles.push({x: cx, y: cy, vx: (Math.random()-0.5)*2, vy: (Math.random()-0.5)*2, life: 1}); 
            for(let i=0; i<particles.length; i++) { 
                let p = particles[i]; p.x += p.vx; p.y += p.vy; p.life -= 0.02; 
                if(p.life <= 0) { particles.splice(i, 1); i--; continue; } 
                ctx.fillStyle = `rgba(${rgbInner}, ${p.life})`; ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI*2); ctx.fill(); 
            } 
        } 
    }
    audio.onplay = setup; requestAnimationFrame(draw);
</script>
"""

# ==========================================
# 📅 GOOGLE CALENDAR CONTROLLER (手足となる機能)
# ==========================================
def get_calendar_service(json_str):
    if not json_str: return None
    try:
        creds_dict = json.loads(json_str)
        creds = Credentials.from_service_account_info(
            creds_dict, scopes=['https://www.googleapis.com/auth/calendar']
        )
        return build('calendar', 'v3', credentials=creds)
    except Exception as e:
        return None

def get_upcoming_events(service):
    if not service: return "カレンダーが連携されていません。"
    try:
        now = datetime.datetime.utcnow().isoformat() + 'Z'
        events_result = service.events().list(calendarId='primary', timeMin=now,
                                              maxResults=5, singleEvents=True,
                                              orderBy='startTime').execute()
        events = events_result.get('items', [])
        if not events: return "直近の予定はありません。"
        
        res = "【直近の予定】\n"
        for event in events:
            start = event['start'].get('dateTime', event['start'].get('date'))
            # 見やすくフォーマット
            start_formatted = start[:16].replace('T', ' ')
            res += f"- {start_formatted} : {event['summary']}\n"
        return res
    except Exception as e:
        return f"予定の取得に失敗しました: {e}"

def create_calendar_event(service, title, start_time, end_time):
    if not service: return False
    try:
        event = {
            'summary': title,
            'start': {'dateTime': start_time, 'timeZone': 'Asia/Tokyo'},
            'end': {'dateTime': end_time, 'timeZone': 'Asia/Tokyo'},
        }
        service.events().insert(calendarId='primary', body=event).execute()
        return True
    except Exception as e:
        return False

# ==========================================
# 🤖 Agent Engine に道具（カレンダー・シート・DB）を注入
# ==========================================
if AGENT_AVAILABLE:
    try:
        agent.register_services(
            sheet=sheet,
            get_calendar_service=get_calendar_service,
            create_calendar_event=create_calendar_event,
            supabase=(supabase if DB_CONNECTED else None),
        )
    except Exception:
        pass

# 💰 Income Engine にも道具（Supabase / AI）を注入
if INCOME_AVAILABLE:
    try:
        income_engine.register_services(
            supabase=(supabase if DB_CONNECTED else None),
            get_ai_response=get_ai_response,
        )
    except Exception:
        pass

# 🧠 長期記憶レイヤに本体Supabase（JWT適用済＝RLS有効）を渡す。
#    MEMORY_SUPABASE_* が設定されていれば memory.py 側が別プロジェクトを使う。
if MEMORY_LAYER:
    try:
        _memory_layer.register_main(supabase if DB_CONNECTED else None)
    except Exception:
        pass

# ==========================================
# 🔮 中央コア（純CSS・JS無し＝Streamlitフロントを落とさない安定版）
#   旧 MASTER_CORE_TEMPLATE（st.components.v1.html の重いJSキャンバス）の置換。
# ==========================================
def render_core(height=240):
    h = int(height)
    glow = int(h * 0.42); o1 = int(h * 0.98); o2 = int(h * 0.84); o3 = int(h * 0.84)
    cont = max(o1, o2, o3)
    st.markdown(f"""
    <div class="forge-core" style="height:{h}px">
      <div class="fc-3d">
        <div class="fc-glow"></div>
        <div class="fc-orbit fc-o1"></div>
        <div class="fc-orbit fc-o2"></div>
        <div class="fc-orbit fc-o3"></div>
      </div>
    </div>
    <style>
    .forge-core {{ position:relative; width:100%; display:flex; align-items:center; justify-content:center;
        perspective:{h*3}px; }}
    .fc-3d {{ position:relative; width:{cont}px; height:{cont}px; transform-style:preserve-3d;
        display:flex; align-items:center; justify-content:center; }}
    .fc-glow {{ width:{glow}px; height:{glow}px; border-radius:50%;
        background: radial-gradient(circle, #ffffff 0%, #dbeaff 30%, rgba(140,190,255,0.30) 58%, transparent 74%);
        box-shadow: 0 0 {int(h*0.3)}px {int(h*0.06)}px rgba(150,200,255,0.30);
        animation: fc-pulse 3.4s ease-in-out infinite; }}
    .fc-orbit {{ position:absolute; inset:0; margin:auto; border-radius:50%; transform-style:preserve-3d; }}
    .fc-orbit::before {{ content:""; position:absolute; top:-3px; left:50%; width:6px; height:6px; margin-left:-3px;
        border-radius:50%; background:#ffffff; box-shadow:0 0 10px 2px rgba(200,225,255,0.95); }}
    .fc-o1 {{ width:{o1}px; height:{o1}px; border:1px solid rgba(200,222,255,0.65); animation: fc-orb1 7s linear infinite; }}
    .fc-o2 {{ width:{o2}px; height:{o2}px; border:1px solid rgba(190,215,255,0.40); animation: fc-orb2 12s linear infinite; }}
    .fc-o3 {{ width:{o3}px; height:{o3}px; border:1px solid rgba(185,210,255,0.22); animation: fc-orb3 17s linear infinite; }}
    @keyframes fc-orb1 {{ from{{transform:rotateX(74deg) rotateZ(0)}} to{{transform:rotateX(74deg) rotateZ(360deg)}} }}
    @keyframes fc-orb2 {{ from{{transform:rotateZ(-50deg) rotateX(66deg) rotateZ(0)}} to{{transform:rotateZ(-50deg) rotateX(66deg) rotateZ(360deg)}} }}
    @keyframes fc-orb3 {{ from{{transform:rotateZ(50deg) rotateX(66deg) rotateZ(0)}} to{{transform:rotateZ(50deg) rotateX(66deg) rotateZ(-360deg)}} }}
    @keyframes fc-pulse {{ 0%,100%{{transform:scale(0.95); opacity:.92}} 50%{{transform:scale(1.06); opacity:1}} }}
    </style>
    """, unsafe_allow_html=True)


# ==========================================
# 🔒 アクセス制御（owner専用 / 課金ゲート）の画面
# ==========================================
def render_owner_only(feature_name):
    st.markdown(f"<h2 style='letter-spacing:2px;'>🔒 {feature_name}</h2>", unsafe_allow_html=True)
    st.warning("この機能はオーナー（管理者）専用です。")
    st.caption("自己進化モードはシステム全体（全ユーザー）に影響し得るため、オーナーのみが実行できます。")
    if st.button("⬅️ HUB に戻る", key="owner_only_back"):
        st.session_state.current_mode = "HUB"; st.rerun()

def render_income_paywall():
    st.markdown("<h2 style='letter-spacing:2px;'>💰 Auto Income — サブスクリプション</h2>", unsafe_allow_html=True)
    st.info("Auto Income（副業自動化）は有料プランの機能です。オーナーは無料で利用できます。")
    user = auth.current_user() or {}
    # 最新の購読状態を同期（解約の反映＝Webhook無しのフォールバック）
    if BILLING_AVAILABLE:
        try:
            billing.sync_status(supabase, get_secret, user)
            auth.refresh_profile(supabase)
            user = auth.current_user() or {}
        except Exception:
            pass
    if auth.income_active(user):
        st.success("購読は有効です。下のボタンで読み込み直してください。")
        if st.button("🔄 再読み込み", key="paywall_reload"):
            st.rerun()
        return
    if BILLING_AVAILABLE and billing.enabled(get_secret):
        url, err = billing.create_checkout_url(get_secret, user)
        if url:
            try:
                st.link_button("💳 サブスクに登録する（Stripe）", url, use_container_width=True, type="primary")
            except Exception:
                st.markdown(f"[💳 サブスクに登録する（Stripe）]({url})")
        else:
            st.error(err or "決済リンクを作成できませんでした。")
            st.caption("オーナーが Stripe（STRIPE_SECRET_KEY / STRIPE_PRICE_ID / APP_BASE_URL）を設定する必要があります。")
    else:
        st.warning("現在オンライン決済は準備中です。オーナーにお問い合わせください（手動で解放することも可能です）。")
    if st.button("⬅️ HUB に戻る", key="paywall_back"):
        st.session_state.current_mode = "HUB"; st.rerun()

# ==========================================
# 🖥️ 4. メイン画面の表示 (モジュール・ルーター)
# ==========================================

if page == "HUB":
    with open("views/1_🏠_HUB.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Forge Lab":
    with open("views/2_🧪_Forge_Lab.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Document Vault":
    with open("views/3_⌘_Document_Vault.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Active Tasks" or page == "📋 現在のタスク":
    with open("views/4_⚡_Active_Tasks.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Dashboard" or page == "DASHBOARD":
    with open("views/5_📊_Dashboard.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "App Archive" or page == "APP ARCHIVE":
    with open("views/6_📦_App_Archive.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Auto Income" or page == "💰 AUTO INCOME":
    if AUTH_ON and not auth.income_active():
        render_income_paywall()
    else:
        with open("views/10_💰_Auto_Income.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Task History" or page == "🕰️ 過去のタスク":
    with open("views/7_🕰️_Task_History.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Settings" or page == "⚙️ SETTINGS":
    with open("views/8_⚙️_Settings.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Core Upgrade":
    if AUTH_ON and not auth.is_owner():
        render_owner_only("Core Upgrade（自己進化）")
    else:
        with open("views/9_🚀_Core_Upgrade.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "AI Studio":
    with open("views/11_🎨_AI_Studio.py", "r", encoding="utf-8") as f: exec(f.read())

# ==========================================
# 🎨 DESIGN SYSTEM (assets/style.css)：白×銀×黒、コア基調のダークで全ページ統一。
# ==========================================
try:
    with open("assets/style.css", "r", encoding="utf-8") as _css:
        st.markdown(f"<style>{_css.read()}</style>", unsafe_allow_html=True)
except Exception:
    pass