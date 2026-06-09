st.markdown("""
    <style>
    .cyber-title { color: #2b6cb0; font-weight: 800; letter-spacing: 2px; margin-bottom: 20px; text-shadow: 2px 2px 4px rgba(255,255,255,0.8); }
    .app-card {
        background: rgba(255, 255, 255, 0.04); backdrop-filter: blur(10px);
        border: 1px solid #20202a; border-radius: 15px;
        padding: 20px; margin-bottom: 15px; transition: all 0.3s ease;
        box-shadow: 4px 4px 10px #000000, -3px -3px 10px #15151c;
    }
    .app-card:hover { transform: translateY(-5px); border-color: #3182ce; box-shadow: 0 8px 25px rgba(49, 130, 206, 0.3); }
    </style>
""", unsafe_allow_html=True)

# アプリ保存用のフォルダを作成
APPS_DIR = "forge_apps"
os.makedirs(APPS_DIR, exist_ok=True)

# 💡 初回テスト用：空っぽだと寂しいのでサンプルの「ポモドーロタイマー」を自動生成
sample_app_path = os.path.join(APPS_DIR, "pomodoro_timer.py")
if not os.path.exists(sample_app_path):
    with open(sample_app_path, "w", encoding="utf-8") as f:
        f.write("""import streamlit as st\nimport time\nst.subheader("🍅 Pomodoro Timer")\nminutes = st.slider("集中する時間 (分)", 1, 60, 25)\nif st.button("Start Timer", type="primary"): \n    with st.empty():\n        for i in range(minutes * 60, -1, -1):\n            mins, secs = divmod(i, 60)\n            st.markdown(f"<h1 style='text-align:center; color:#e53e3e; font-size: 80px;'>{mins:02d}:{secs:02d}</h1>", unsafe_allow_html=True)\n            time.sleep(1)\n        st.success("🎉 時間です！お疲れ様でした！")\n""")

# フォルダ内のPythonファイル（アプリ）を取得
app_files = [f for f in os.listdir(APPS_DIR) if f.endswith(".py")]

if "running_app" not in st.session_state:
    st.session_state.running_app = None

# ==========================================
# 画面A：アプリ一覧・検索画面
# ==========================================
if st.session_state.running_app is None:
    st.markdown("<h2 class='cyber-title'>📦 APP ARCHIVE</h2>", unsafe_allow_html=True)
    st.caption("/// FORGE LABで開発した専用ミニアプリの保管庫・ランチャー ///")
    
    search_query = st.text_input("🔍 アプリを検索...", placeholder="アプリ名を入力", label_visibility="collapsed")
    
    if search_query:
        app_files = [f for f in app_files if search_query.lower() in f.lower()]

    if not app_files:
        st.info("インストールされているアプリはありません。FORGE LABでAIに作らせて保存しましょう！")
    else:
        st.markdown("---")
        # 3列で美しくカードを表示
        cols = st.columns(3)
        for i, app_file in enumerate(app_files):
            app_name = app_file.replace(".py", "").replace("_", " ").title()
            with cols[i % 3]:
                st.markdown(f"""
                <div class="app-card">
                    <h4 style="color: #2b6cb0; margin-bottom: 5px;">🧩 {app_name}</h4>
                    <div style="font-size: 11px; color: #718096; margin-bottom: 15px; font-family: monospace;">File: {app_file}</div>
                </div>
                """, unsafe_allow_html=True)
                if st.button(f"🚀 起動する", key=f"launch_{app_file}", use_container_width=True):
                    st.session_state.running_app = app_file
                    st.rerun()

# ==========================================
# 画面B：アプリ実行（大画面）モード
# ==========================================
else:
    app_file = st.session_state.running_app
    app_name = app_file.replace(".py", "").replace("_", " ").title()
    
    col_title, col_close = st.columns([8, 2])
    with col_title:
        st.markdown(f"<h2 class='cyber-title'>🟢 Running: {app_name}</h2>", unsafe_allow_html=True)
    with col_close:
        st.markdown("<br>", unsafe_allow_html=True)
        if st.button("✖️ 終了して戻る", use_container_width=True, type="primary"):
            st.session_state.running_app = None
            st.rerun()
    
    st.markdown("---")
    
    # ⚠️ アプリのコードを読み込んでOS内部で直接実行 (Sandbox)
    try:
        with st.container(border=True):
            app_path = os.path.join(APPS_DIR, app_file)
            with open(app_path, "r", encoding="utf-8") as f:
                app_code = f.read()
            
            # OS本体の変数を壊さないように、専用の独立空間（辞書）を用意して実行
            import time
            exec_globals = {"st": st, "pd": pd, "datetime": datetime, "time": time, "os": os, "json": json}
            exec(app_code, exec_globals)
            
    except Exception as e:
        st.error(f"アプリの実行中にエラーが発生しました: {e}")
        with st.expander("🛠️ コードを確認する"):
            st.code(app_code, language="python")