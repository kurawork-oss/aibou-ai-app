import streamlit as st
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
    from asset_engine import generate_ambient_wav, generate_thumbnail
    ASSET_AVAILABLE = True
except Exception:
    ASSET_AVAILABLE = False

    def generate_ambient_wav(*a, **k): return None, "⚠️ asset_engine を読み込めませんでした。"
    def generate_thumbnail(*a, **k): return None

try:
    supabase: Client = create_client(get_secret("SUPABASE_URL"), get_secret("SUPABASE_KEY"))
    hasher = hashlib.sha256(get_secret("MASTER_ENCRYPTION_KEY").encode('utf-8')).digest()
    cipher_suite = Fernet(base64.urlsafe_b64encode(hasher))
    DB_CONNECTED = True
except Exception as e:
    DB_CONNECTED = False
    supabase = None

def load_vault():
    if not DB_CONNECTED: return {}
    try:
        res = supabase.table("vault_data").select("encrypted_keys").eq("id", 1).execute()
        if res.data and res.data[0].get("encrypted_keys"):
            enc_data = res.data[0]["encrypted_keys"]
            if enc_data == '': return {} # 初期状態
            decrypted = cipher_suite.decrypt(enc_data.encode('utf-8'))
            return json.loads(decrypted.decode('utf-8'))
    except Exception as e:
        st.error(f"🚨 【DB読み込みエラー】: {e}")
    return {}

def save_vault(data):
    if not DB_CONNECTED: return False
    try:
        encrypted = cipher_suite.encrypt(json.dumps(data).encode('utf-8')).decode('utf-8')
        res = supabase.table("vault_data").upsert({"id": 1, "encrypted_keys": encrypted}).execute()
        return True
    except Exception as e:
        st.error(f"🚨 【DB書き込みエラー】: {e}")
        return False

# === システム起動時の「金庫の鍵」自動読み込み ===
if "global_api_keys" not in st.session_state:
    st.session_state.global_api_keys = {}
    vd = load_vault()
    st.session_state.global_api_keys = vd.get("api_keys", {})
    # 用途別キー（マルチアカウント）も同じVaultから読み込む
    st.session_state.key_slots = vd.get("key_slots", {})
if "key_slots" not in st.session_state:
    st.session_state.key_slots = {}

# === 🧠 全ページ共通のAI会話履歴（ページ移動で文脈が消えないようにする） ===
if "global_chat_history" not in st.session_state:
    st.session_state.global_chat_history = []
# 外部に作用する操作（カレンダー登録・通知）の承認待ちアクション
if "pending_action" not in st.session_state:
    st.session_state.pending_action = None

st.set_page_config(page_title="AIbou", page_icon="❖", layout="wide")

# ==========================================
# 🔐 1. ログインシステム
# ==========================================
if "logged_in" not in st.session_state:
    st.session_state.logged_in = False

if not st.session_state.logged_in:
    st.title("相棒AI 起動シークエンス")
    password = st.text_input("Password", type="password")
    if st.button("システム起動"):
        if password == st.secrets.get("APP_PASSWORD", "boss"): 
            st.session_state.logged_in = True
            st.rerun()
        else:
            st.error("パスワードが違います。")
    st.stop()

# ==========================================
# 🧭 2. THE AIbou OS セントラルルーティング
# ==========================================
if "current_mode" not in st.session_state:
    st.session_state.current_mode = "HUB"

if st.session_state.current_mode == "HUB":
    st.markdown("""
        <style>
        [data-testid="collapsedControl"] { display: none !important; }
        [data-testid="stSidebar"] { display: none !important; }
        </style>
    """, unsafe_allow_html=True)
    page = "HUB"
else:
    st.sidebar.markdown("<h2 style='text-align:center; color:#2b6cb0; font-weight:900; letter-spacing:2px; margin-bottom: 20px;'>THE FORGE</h2>", unsafe_allow_html=True)
    if st.sidebar.button("⬅️ RETURN TO HUB", use_container_width=True):
        st.session_state.current_mode = "HUB"
        st.rerun()
    st.sidebar.markdown("---")
    
    st.sidebar.caption("QUICK JUMP")
    page_names = {
        "Forge Lab": "FORGE LAB",
        "Document Vault": "DATA VAULT",
        "Active Tasks": "ACTIVE TASKS",
        "Core Upgrade": "EVOLUTION",
        "Dashboard": "DASHBOARD",
        "App Archive": "APP ARCHIVE",
        "Auto Income": "💰 AUTO INCOME",
        "Task History": "TASK HISTORY",
        "Settings": "⚙️ SETTINGS" # 🚨ここを「Secure Vault」から「Settings」に変更！
    }
    
    current_index = list(page_names.keys()).index(st.session_state.current_mode) if st.session_state.current_mode in page_names else 0
    new_mode = st.sidebar.radio("QUICK JUMP", list(page_names.keys()), index=current_index, format_func=lambda x: page_names[x], label_visibility="collapsed")
    
    if new_mode != st.session_state.current_mode:
        st.session_state.current_mode = new_mode
        st.rerun()
        
    page = st.session_state.current_mode

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

if st.sidebar.button("Logout"):
    st.session_state.logged_in = False
    st.rerun()

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
        background: rgba(240, 242, 246, 0.85); backdrop-filter: blur(15px); border: 1px solid #cbd5e0; 
        border-radius: 20px; padding: 20px; box-shadow: 0px 10px 30px rgba(0, 0, 0, 0.1); 
        width: 280px; max-height: 90%; overflow-y: auto; z-index: 99999; 
        font-family: 'Segoe UI', sans-serif; color: #2d3748; font-size: 12px; 
    }
    #core-settings input[type=range] { accent-color: #00f3ff; cursor: pointer; width: 100%; }
    #core-settings select { background: rgba(255,255,255,0.5); border: 1px solid #cbd5e0; border-radius: 8px; padding: 5px; outline: none; width: 100%; cursor: pointer; }
    #core-settings input[type=color] { border: none; background: transparent; cursor: pointer; width: 30px; height: 30px; padding: 0; }
    #core-settings button:hover { filter: brightness(1.1); }
</style>

<div id="core-wrapper" style="position:relative; width:100%; height:H_VALpx; display:flex; justify-content:center; align-items:center;">
    <div id="core-container" style="cursor:pointer; display:flex; flex-direction:column; align-items:center; z-index:10; width:100%;">
        <canvas id="visualizer" width="280" height="280" style="filter:drop-shadow(0 8px 20px rgba(0, 150, 255, 0.3));"></canvas>
        <div id="status-info" style="margin-top:10px; font-size:11px; letter-spacing:6px; color:#3182ce; font-family:monospace; font-weight:bold;">SYSTEM ONLINE</div>
    </div>

    <div id="core-settings">
        <h4 style="margin:0 0 15px 0; color:#1a202c; text-align:center; font-weight:800; letter-spacing:2px;">A.I. SETTINGS</h4>
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
    const DEFAULTS = { speed: 1.5, vol: 1, filter: false, innerColor: "#00f3ff", outerColor: "#0064ff", pulse: 2, particles: false, showMic: false, showChat: true };
    
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
    function draw() { 
        requestAnimationFrame(draw); 
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
    audio.onplay = setup; draw();
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
    with open("views/10_💰_Auto_Income.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Task History" or page == "🕰️ 過去のタスク":
    with open("views/7_🕰️_Task_History.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Settings" or page == "⚙️ SETTINGS":
    with open("views/8_⚙️_Settings.py", "r", encoding="utf-8") as f: exec(f.read())

elif page == "Core Upgrade":
    with open("views/9_🚀_Core_Upgrade.py", "r", encoding="utf-8") as f: exec(f.read())