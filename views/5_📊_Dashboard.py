import streamlit as st
import os
import json
import uuid

try:
    from streamlit_flow import streamlit_flow
    from streamlit_flow.elements import StreamlitFlowNode, StreamlitFlowEdge
    from streamlit_flow.state import StreamlitFlowState
    HAS_FLOW = True
except ImportError:
    HAS_FLOW = False

st.markdown("""
    <style>
    .cyber-title { color: #2b6cb0; font-weight: 800; letter-spacing: 2px; margin-bottom: 5px; text-shadow: 2px 2px 4px rgba(255,255,255,0.8); }
    .dash-card { background: rgba(255, 255, 255, 0.04); backdrop-filter: blur(10px); border: 1px solid #20202a; border-radius: 15px; padding: 20px; box-shadow: 6px 6px 15px #000000, -4px -4px 12px #15151c; height: 100%; }
    .stat-value { font-size: 32px; font-weight: 900; color: #c5c6c7; }
    .stat-label { font-size: 14px; font-weight: bold; color: #9aa0a8; }
    .event-item { border-left: 4px solid #c5c6c7; margin-bottom: 10px; background: rgba(255,255,255,0.05); padding: 12px; border-radius: 5px; box-shadow: 2px 2px 5px rgba(0,0,0,0.4);}
    
    /* Miro V2 CSS: キャンバスを最大化 */
    .miro-container { background: #0b0b12; border-radius: 15px; box-shadow: inset 5px 5px 15px #000000, inset -5px -5px 15px #15151c; padding: 5px; margin-top: 10px; }
    .react-flow { background: transparent !important; }
    div[data-baseweb="tab-list"] { gap: 10px; }
    div[data-baseweb="tab"] { background: transparent !important; border-radius: 10px 10px 0 0 !important; padding: 10px 20px !important; font-weight: bold !important; }
    </style>
""", unsafe_allow_html=True)

st.markdown("<h2 class='cyber-title'>🧠 SYSTEM DASHBOARD & MIRO</h2>", unsafe_allow_html=True)

tab_miro, tab_system = st.tabs(["🧠 Miro Board (無限キャンバス)", "📊 System Monitor (監視)"])

# ====================================================
# 🧠 TAB 1: MIRO BOARD V2 (超進化版)
# ====================================================
with tab_miro:
    if not HAS_FLOW:
        st.error("⚠️ `streamlit-flow-component` がインストールされていません。")
    else:
        # 🌟 要望9: 複数ダッシュボードの管理
        if 'miro_boards' not in st.session_state:
            default_style = {"background": "#0b0b12", "border": "2px solid #c5c6c7", "borderRadius": "12px", "color": "#e6e8ec", "fontWeight": "bold", "padding": "15px", "boxShadow": "5px 5px 10px #000000"}
            initial_node = StreamlitFlowNode(id='core_node', pos=(250, 250), data={'content': '🧠 AIBOU Core'}, node_type='default', source_position='right', target_position='left', style=default_style)
            st.session_state.miro_boards = {"Main Board": StreamlitFlowState([initial_node], [])}
        
        # 🌟 要望3 & 6: モバイル配慮と画面一面化（ツールメニューを折りたたみ式に）
        with st.expander("🛠️ ボード操作パネル (クリックで開閉 / 複数ボード管理)", expanded=False):
            col_board, col_style, col_action = st.columns([3, 4, 3])
            
            with col_board:
                st.markdown("**📂 ボード管理**")
                board_names = list(st.session_state.miro_boards.keys())
                current_board = st.selectbox("操作中のボード", board_names, label_visibility="collapsed")
                
                new_board_name = st.text_input("新規ボード名", placeholder="新しいボードを作成...")
                if st.button("➕ ボード追加", use_container_width=True) and new_board_name:
                    if new_board_name not in st.session_state.miro_boards:
                        st.session_state.miro_boards[new_board_name] = StreamlitFlowState([], [])
                        st.rerun()

            with col_style:
                st.markdown("**🎨 デザイン設定（次に投下する付箋用）**")
                c1, c2 = st.columns(2)
                with c1: shape = st.selectbox("形状", ["角丸 (Default)", "四角 (Square)", "丸 (Circle)"], label_visibility="collapsed")
                with c2: bg_color = st.color_picker("背景色", "#ffffff")
                
                border_radius = "12px"
                if shape == "四角 (Square)": border_radius = "0px"
                if shape == "丸 (Circle)": border_radius = "50%"

            with col_action:
                st.markdown("**✨ 一括操作**")
                # 🌟 要望4: ノードの自動整列
                if st.button("📐 自動整列 (Grid)", use_container_width=True):
                    for i, node in enumerate(st.session_state.miro_boards[current_board].nodes):
                        node.pos = ((i % 4) * 250 + 50, (i // 4) * 150 + 50) # 4列のグリッドに並べ直し
                    st.rerun()
                if st.button("🗑️ ボード初期化", use_container_width=True):
                    st.session_state.miro_boards[current_board] = StreamlitFlowState([], [])
                    st.rerun()

        st.caption("💡 【操作ガイド】ノードの端をドラッグで結線 / 選択して「Backspace」で削除 / マウスホイールでズーム")

        # 🌟 要望1: Enterキーで即投入（フォーム化）
        with st.form("add_node_form", clear_on_submit=True):
            col_input, col_btn = st.columns([8, 2])
            with col_input:
                new_node_text = st.text_input("📝 ここに入力して [Enter] で付箋をスピード投下！", placeholder="アイデアを入力...")
            with col_btn:
                st.markdown("<br>", unsafe_allow_html=True)
                submitted = st.form_submit_button("投下 ⚡", use_container_width=True)
            
            if submitted and new_node_text:
                custom_style = {
                    "background": bg_color, "border": "2px solid #a0aec0", "borderRadius": border_radius,
                    "color": "#e6e8ec", "fontWeight": "bold", "padding": "15px", "boxShadow": "3px 3px 8px #000000"
                }
                new_id = f"node_{uuid.uuid4().hex[:6]}"
                new_pos = (50, 50) # 左上に固定出現（その後自分でドラッグ）
                new_node = StreamlitFlowNode(id=new_id, pos=new_pos, data={'content': new_node_text}, node_type='default', source_position='right', target_position='left', style=custom_style)
                st.session_state.miro_boards[current_board].nodes.append(new_node)
                st.rerun()

        # 🗺️ 思考キャンバスの描画（高さを700に拡大して全画面に近い操作感へ）
        st.markdown("<div class='miro-container'>", unsafe_allow_html=True)
        # 🌟 返り値(最新状態)を session_state に必ず戻す → ドラッグ/結線/削除が保存される
        #    （以前は返り値を捨てていたため操作が消えていた＝Miroが正しく動かない原因）
        _new_state = streamlit_flow(
            f"miro_board_{current_board}",
            st.session_state.miro_boards[current_board],
            height=700,
            fit_view=True,
            enable_node_menu=True,   # メニューから削除可能
            enable_edge_menu=True,   # 結線も削除可能
        )
        if _new_state is not None:
            st.session_state.miro_boards[current_board] = _new_state
        st.markdown("</div>", unsafe_allow_html=True)

# ====================================================
# 📊 TAB 2: SYSTEM MONITOR (Original Code 変更なし)
# ====================================================
with tab_system:
    try:
        vault_data = load_vault()
    except NameError:
        vault_data = {"api_keys": {}}
        
    my_email = vault_data.get("api_keys", {}).get("my_email", "")
    gcal_json_str = vault_data.get("api_keys", {}).get("google_calendar", "")

    STATS_FILE = "system_stats.json"
    if not os.path.exists(STATS_FILE):
        with open(STATS_FILE, "w", encoding="utf-8") as f:
            json.dump({"gemini_api_calls": 0, "total_tasks": 0}, f)
    with open(STATS_FILE, "r", encoding="utf-8") as f:
        stats_data = json.load(f)

    col1, col2, col3 = st.columns(3)
    with col1:
        st.markdown(f"<div class='dash-card'><div class='stat-label'>⚡ Gemini API</div><div class='stat-value'>{stats_data.get('gemini_api_calls', 0)} <span style='font-size:16px;'>回</span></div></div>", unsafe_allow_html=True)
    with col2:
        st.markdown("<div class='dash-card'><div class='stat-label'>🚀 OS 稼働状態</div><div class='stat-value' style='color:#c5c6c7;'>ONLINE</div></div>", unsafe_allow_html=True)
    with col3:
        st.markdown(f"<div class='dash-card'><div class='stat-label'>📧 同期アカウント</div><div style='font-size: 13px; font-weight:bold; margin-top:10px; color:#e6e8ec; word-break: break-all;'>{my_email if my_email else 'Vault未設定'}</div></div>", unsafe_allow_html=True)

    st.markdown("<br>", unsafe_allow_html=True)
    col_cal, col_log = st.columns([6, 4], gap="large")

    with col_cal:
        st.markdown("#### 📅 UPCOMING EVENTS")
        if not gcal_json_str or not my_email:
            st.info("VaultにカレンダーJSONとGmailが未設定です。")
        else:
            try:
                from google.oauth2 import service_account
                from googleapiclient.discovery import build
                import datetime
                gcal_info = json.loads(gcal_json_str)
                credentials = service_account.Credentials.from_service_account_info(gcal_info, scopes=['https://www.googleapis.com/auth/calendar.readonly'])
                service = build('calendar', 'v3', credentials=credentials)
                now = datetime.datetime.utcnow().isoformat() + 'Z'
                events_result = service.events().list(calendarId=my_email, timeMin=now, maxResults=5, singleEvents=True, orderBy='startTime').execute()
                events = events_result.get('items', [])
                if not events:
                    st.info("直近の予定はありません。")
                else:
                    for event in events:
                        start = event['start'].get('dateTime', event['start'].get('date'))
                        try:
                            dt = datetime.datetime.fromisoformat(start.replace('Z', '+00:00'))
                            start_str = dt.strftime('%Y/%m/%d %H:%M')
                        except: start_str = start
                        st.markdown(f"<div class='event-item'><b style='color:#2b6cb0; font-size:16px;'>{event.get('summary', '予定なし')}</b><br><span style='font-size:13px; color:#4a5568;'>🕒 {start_str}</span></div>", unsafe_allow_html=True)
            except Exception as e: st.error(f"カレンダー取得エラー: {e}")

    with col_log:
        st.markdown("#### 📡 SYSTEM ACTIVITY")
        st.markdown("<div class='dash-card' style='height: 300px; overflow-y: scroll; font-family: monospace; font-size:12px;'><span style='color:#a0aec0;'>[SYSTEM] Dashboard initialized.</span><br><span style='color:#c5c6c7;'>[VAULT] Secure keys loaded.</span><br></div>", unsafe_allow_html=True)
