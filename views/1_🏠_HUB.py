if "hub_view_mode" not in st.session_state: st.session_state.hub_view_mode = "CORE"

# ☀️ DAYLIGHT ORBITAL (Light Neumorphism + Arc Reactor)
st.markdown("""
    <style>
    /* 1. 全体をクリーンなライトグレー（ネオモーフィズムベース）に */
    [data-testid="stAppViewContainer"], .stApp { 
        background-color: #e0e5ec !important; 
        background-image: none !important;
        overflow-y: hidden !important; 
    }
    
    .hub-title { 
        text-align: center; color: #4a5568; font-weight: 900;
        letter-spacing: 12px; margin-bottom: 30px; font-family: 'Share Tech Mono', 'Segoe UI', sans-serif;
        text-shadow: 2px 2px 5px rgba(255,255,255,0.7);
    }

    /* 2. 透明感のあるネオモーフィズムボタン */
    div.stButton > button {
        background: #e0e5ec !important; 
        border: none !important; 
        border-radius: 12px !important; 
        color: #4a5568 !important; font-weight: 700 !important; letter-spacing: 2px !important;
        box-shadow: 5px 5px 10px #b8bcc2, -5px -5px 10px #ffffff !important;
        transition: all 0.2s ease !important; padding: 10px !important; font-size: 13px !important;
    }
    div.stButton > button:hover {
        box-shadow: inset 4px 4px 8px #b8bcc2, inset -4px -4px 8px #ffffff !important;
        color: #00f3ff !important;
        transform: translateY(1px);
    }
    
    .view-toggle button {
        border-radius: 20px !important; padding: 5px 15px !important; font-size: 11px !important;
        background: #e0e5ec !important; color: #4a5568 !important;
        box-shadow: 3px 3px 6px #b8bcc2, -3px -3px 6px #ffffff !important;
    }
    .view-toggle button:hover { color: #00f3ff !important; }

    /* 🌟 3. 衛星軌道パネル（分厚いアクリル発光エッジ仕様） */
    [data-testid="stVerticalBlockBorderWrapper"] {
        background: #e0e5ec !important;
        border: none !important;
        transition: all 0.3s ease !important;
        padding: 15px !important;
    }
    
    /* 左側のパネル (FACTORY, AGENCY): 内側へ発光する分厚いシアンのフチ */
    [data-testid="column"]:nth-of-type(1) [data-testid="stVerticalBlockBorderWrapper"] {
        border-radius: 15px 70px 70px 15px !important;
        border-right: 6px solid rgba(0, 210, 255, 0.5) !important;
        box-shadow: 8px 8px 16px #b8bcc2, -8px -8px 16px #ffffff, inset -4px 0px 12px rgba(0, 210, 255, 0.15) !important;
    }
    [data-testid="column"]:nth-of-type(1) [data-testid="stVerticalBlockBorderWrapper"]:hover {
        border-right: 6px solid #00f3ff !important;
        box-shadow: 12px 12px 20px #b8bcc2, -12px -12px 20px #ffffff, inset -8px 0px 20px rgba(0, 243, 255, 0.4) !important;
        transform: translateY(-2px);
    }
    
    /* 右側のパネル (BRAIN, CORE): 内側へ発光する分厚いシアンのフチ */
    [data-testid="column"]:nth-of-type(3) [data-testid="stVerticalBlockBorderWrapper"] {
        border-radius: 70px 15px 15px 70px !important;
        border-left: 6px solid rgba(0, 210, 255, 0.5) !important;
        box-shadow: 8px 8px 16px #b8bcc2, -8px -8px 16px #ffffff, inset 4px 0px 12px rgba(0, 210, 255, 0.15) !important;
    }
    [data-testid="column"]:nth-of-type(3) [data-testid="stVerticalBlockBorderWrapper"]:hover {
        border-left: 6px solid #00f3ff !important;
        box-shadow: 12px 12px 20px #b8bcc2, -12px -12px 20px #ffffff, inset 8px 0px 20px rgba(0, 243, 255, 0.4) !important;
        transform: translateY(-2px);
    }
    
    .panel-header {
        font-weight: 900; color: #2d3748; letter-spacing: 4px; font-size: 14px; 
        margin-bottom: 15px; text-shadow: 1px 1px 2px #ffffff;
    }
    .panel-header-left { text-align: left; }
    .panel-header-right { text-align: right; }
    
    /* 入力欄（チャット）のライト化 */
    [data-testid="stChatInput"] { background: transparent !important; border: none !important; }
    </style>
""", unsafe_allow_html=True)

st.markdown("<h2 class='hub-title'>⬡ THE FORGE OS</h2>", unsafe_allow_html=True)

if "global_chat_history" not in st.session_state: st.session_state.global_chat_history = []
if "ai_voice_base64" not in st.session_state: st.session_state.ai_voice_base64 = None
if "just_generated_audio" not in st.session_state: st.session_state.just_generated_audio = False
if "pending_action" not in st.session_state: st.session_state.pending_action = None

v_data = st.session_state.ai_voice_base64 if st.session_state.ai_voice_base64 else ""
autoplay_attr = "autoplay" if st.session_state.just_generated_audio else ""
st.session_state.just_generated_audio = False 

# 👑 カラムを [1 : 1.5 : 1] のワイドグリッドに配置（中央コアを大きく）
core_height = 320
col_left, col_core, col_right = st.columns([1, 1.5, 1], gap="medium")

with col_left:
    st.markdown("<br>", unsafe_allow_html=True)
    if st.session_state.hub_view_mode == "HUB":
        # パネル1: FACTORY
        with st.container(border=True):
            st.markdown("<div class='panel-header panel-header-left'>❖ FACTORY</div>", unsafe_allow_html=True)
            if st.button("＞ Forge Lab", use_container_width=True): st.session_state.current_mode = "Forge Lab"; st.rerun()
            if st.button("＞ App Archive", use_container_width=True): st.session_state.current_mode = "App Archive"; st.rerun()
        
        st.markdown("<br>", unsafe_allow_html=True)
        
        # パネル2: AGENCY
        with st.container(border=True):
            st.markdown("<div class='panel-header panel-header-left'>❖ AGENCY</div>", unsafe_allow_html=True)
            if st.button("＞ Active Tasks", use_container_width=True): st.session_state.current_mode = "Active Tasks"; st.rerun()
            if st.button("＞ Task History", use_container_width=True): st.session_state.current_mode = "Task History"; st.rerun()
            if st.button("＞ Auto Income", use_container_width=True): st.session_state.current_mode = "Auto Income"; st.rerun()

with col_core:
    st.markdown("<div class='view-toggle' style='text-align:center;'>", unsafe_allow_html=True)
    toggle_label = "◈ VIEW: CORE" if st.session_state.hub_view_mode == "HUB" else "◈ VIEW: HUB"
    if st.button(toggle_label, key="toggle_view"):
        st.session_state.hub_view_mode = "CORE" if st.session_state.hub_view_mode == "HUB" else "HUB"
        st.rerun()
    st.markdown("</div>", unsafe_allow_html=True)

    # コアをド真ん中に鎮座させる
    core_html = MASTER_CORE_TEMPLATE.replace("H_VAL", str(core_height)).replace("MAX_Wpx", "300").replace("V_DATA", v_data).replace("A_PLAY", autoplay_attr)
    st.components.v1.html(core_html, height=core_height + 20)
    
    if st.session_state.hub_view_mode == "CORE":
        with st.container(height=280, border=False):
            for m in st.session_state.global_chat_history:
                with st.chat_message(m["role"], avatar=m.get("avatar", "🤖")):
                    st.markdown(m["content"])

with col_right:
    st.markdown("<br>", unsafe_allow_html=True)
    if st.session_state.hub_view_mode == "HUB":
        # パネル3: BRAIN
        with st.container(border=True):
            st.markdown("<div class='panel-header panel-header-right'>BRAIN ❖</div>", unsafe_allow_html=True)
            if st.button("Data Vault ＜", use_container_width=True): st.session_state.current_mode = "Document Vault"; st.rerun()
            if st.button("Miro Board ＜", use_container_width=True): st.session_state.current_mode = "Dashboard"; st.rerun()
            
        st.markdown("<br>", unsafe_allow_html=True)

        # パネル4: CORE
        with st.container(border=True):
            st.markdown("<div class='panel-header panel-header-right'>CORE ❖</div>", unsafe_allow_html=True)
            if st.button("Evolution ＜", use_container_width=True): st.session_state.current_mode = "Core Upgrade"; st.rerun()
            if st.button("Settings ＜", use_container_width=True): st.session_state.current_mode = "Settings"; st.rerun()

# ------------------------------------------
# 🚨 承認ゲート（外部に作用する操作）・マイク・AIチャット処理
# ------------------------------------------
# カレンダー登録・通知送信など「外部に作用する操作」はAIが即実行せず、
# ここでボスの承認（Approve）を得てから execute_tool() で実行する。
if st.session_state.pending_action:
    pa = st.session_state.pending_action
    st.warning(f"⚠️ 以下の操作を実行しますか？\n\n{describe_pending(pa)}")
    c1, c2 = st.columns(2)
    with c1:
        if st.button("✅ 実行する (Approve)", use_container_width=True, key="agent_approve"):
            with st.spinner("実行中..."):
                result = execute_tool(pa["tool"], pa.get("params", {}))
                st.session_state.global_chat_history.append({"role": "assistant", "avatar": "🤖", "content": result})
            st.session_state.pending_action = None
            st.rerun()
    with c2:
        if st.button("❌ キャンセル (Reject)", use_container_width=True, key="agent_reject"):
            st.session_state.global_chat_history.append({"role": "assistant", "avatar": "🤖", "content": "操作をキャンセルしました。"})
            st.session_state.pending_action = None
            st.rerun()

st.markdown("""
    <style>
    iframe[title*='mic'] { mix-blend-mode: multiply !important; opacity: 0.7; transition: all 0.3s ease-in-out; } 
    iframe[title*='mic']:hover { opacity: 1.0; filter: drop-shadow(0px 5px 15px rgba(0, 243, 255, 0.4)); transform: translateY(-2px); } 
    [data-testid='stVerticalBlock'] > div:has(iframe[title*='mic']) { margin-bottom: -25px !important; position: relative; z-index: 50; }
    </style>
""", unsafe_allow_html=True)

col1, col2, col3 = st.columns([4, 4, 4]) 
with col2:
    # 音声入力マイクをコアの直下に配置
    spoken_text = speech_to_text(language='ja', start_prompt="◈ PUSH TO TALK", stop_prompt="⬡ TAP TO SEND", use_container_width=True, just_once=True, key='STT')

if not st.session_state.pending_action:
    if spoken_text:
        st.session_state.global_chat_history.append({"role": "user", "avatar": "👤", "content": spoken_text})
        st.rerun()

    if prompt := st.chat_input("/// コマンドを入力してください、ボス", key="console_input"):
        st.session_state.global_chat_history.append({"role": "user", "avatar": "👤", "content": prompt})
        st.rerun()

if st.session_state.global_chat_history and st.session_state.global_chat_history[-1]["role"] == "user" and not st.session_state.pending_action:
    last_prompt = st.session_state.global_chat_history[-1]["content"]
    prior_history = [
        {"role": m["role"], "content": m["content"]}
        for m in st.session_state.global_chat_history[:-1]
        if m["role"] in ("user", "assistant")
    ]
    with st.chat_message("assistant", avatar="◈"):
        with st.spinner(" "):
            # 🤖 エージェント本体：マルチAI＋ツール実行。
            #    カレンダー登録や通知など外部に作用する操作は pending として返り、
            #    上の承認ゲートでボスの許可を得てから実行される。
            ai_text, _updated, pending = run_agent(last_prompt, prior_history)
            if pending:
                st.session_state.pending_action = pending

            st.markdown(ai_text)

            # 🔊 音声読み上げ（ネットワーク不調でも落ちないように保護）
            try:
                clean_text = ai_text.replace("*", "").replace("#", "").replace("`", "").replace("_", "")
                if clean_text.strip():
                    tts = gTTS(text=clean_text[:200], lang='ja')
                    audio_fp = io.BytesIO()
                    tts.write_to_fp(audio_fp)
                    st.session_state.ai_voice_base64 = base64.b64encode(audio_fp.getvalue()).decode()
                    st.session_state.just_generated_audio = True
            except Exception:
                pass

            st.session_state.global_chat_history.append({"role": "assistant", "avatar": "◈", "content": ai_text})
            st.rerun()
