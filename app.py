import streamlit as st
import traceback
import requests


# ==========================================
# 🚨 EMERGENCY NOTIFICATION SYSTEM
# ==========================================
# 後ほどここにDiscordやLINEのWebhook URLを入れます
WEBHOOK_URL = "" 

def send_sos(error_msg):
    if WEBHOOK_URL:
        try:
            # スマホにSOSを飛ばす処理
            # ※チャットバグ回避のため、バッククォート3つの使用を禁止
            requests.post(WEBHOOK_URL, data={"content": f"🚨 **[EMERGENCY] THE FORGE OS 停止**\n進化プロトコル中に致命的エラーが発生しました。セーフモードで待機中。\n[エラー詳細]\n{error_msg[:1000]}"})
        except:
            pass

# ==========================================
# 🧠 DUAL CORE LAUNCHER
# ==========================================
try:
    # 正常ルート：OS本体（core.py）を読み込んでそのまま実行
    with open("core.py", "r", encoding="utf-8") as f:
        core_code = f.read()
    exec(core_code, globals())

except Exception as e:
    # ==========================================
    # 🛡️ SYSTEM FAILURE : SAFE MODE (緊急リカバリー画面)
    # ==========================================
    error_details = traceback.format_exc()
    
    # ボスのスマホにSOSを送信
    send_sos(str(e))
    
    # 画面を強制的に「レッドアラート」状態に書き換え
    st.markdown("""
        <style>
        .stApp { background-color: #2b0000 !important; }
        /* 🚨文字ダブりの原因だった全指定(*)をやめ、テキスト要素だけを赤く・等幅に指定 */
        h1, h2, h3, p, code, pre, .stMarkdown { color: #ff4d4d !important; font-family: monospace !important; }
        [data-testid="stSidebar"] { display: none !important; }
        .stButton>button { background-color: transparent !important; border: 2px solid #ff4d4d !important; color: #ff4d4d !important; border-radius: 0px !important; font-family: monospace !important; }
        .stButton>button:hover { background-color: #ff4d4d !important; color: #1a0000 !important; }
        </style>
    """, unsafe_allow_html=True)
    
    st.title("🚨 FATAL SYSTEM ERROR")
    st.header("THE FORGE OS: SAFE MODE ACTIVATED")
    st.markdown("---")
    st.error("/// 警告：致命的なコード破損を検知しました。システムはクラッシュを回避し、セーフモードで待機しています。")
    
    with st.expander(">> VIEW CRASH LOGS (エラー原因の特定)"):
        st.code(error_details, language="python")
        
    st.markdown("<br><br>", unsafe_allow_html=True)
    st.markdown("### 🛠️ RECOVERY PROTOCOL (復元メニュー)")
    st.info("※ 次のアップデートでここに「過去のコア履歴一覧」が表示され、1クリックで元の姿に戻れるようになります。")
    
    if st.button(">> ATTEMPT SYSTEM REBOOT (再起動を試みる)", use_container_width=True):
        st.rerun()
