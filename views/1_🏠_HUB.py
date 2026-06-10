# views/1_🏠_HUB.py — THE FORGE OS / コマンドデッキ
# 中央の「コア」を主役に、下部カルーセル（◀ ❖ MODE ▶）でモードを選び、❖で確定すると
# システムボイスが鳴り、その「部屋カード（ホワイトグラス）」が展開する。
# AIコンソール（チャット/音声入力/承認ゲート）も保持。
# 配色・カード等のCSSは assets/style.css（core.py が全ページに適用）。

# --- モード定義（FACTORY / BRAIN / AGENCY / CORE）と部屋（サブメニュー） ---
# rooms: (表示名, サブラベル, 遷移先 current_mode)
MODES = [
    {"name": "FACTORY", "desc": "FACTORY MODE — アプリケーションの錬成、およびプロトタイプのアーカイブを実行します。",
     "rooms": [("Forge Lab", "FORGE LAB", "Forge Lab"), ("App Archive", "APP ARCHIVE", "App Archive")]},
    {"name": "BRAIN", "desc": "BRAIN MODE — 知識の保管と、アイデアの可視化（無限キャンバス）を司ります。",
     "rooms": [("Data Vault", "DATA VAULT", "Document Vault"), ("Miro Board", "MIRO BOARD", "Dashboard")]},
    {"name": "AGENCY", "desc": "AGENCY MODE — タスクの実行管理と、自動収益化のオペレーションを統括します。",
     "rooms": [("Active Tasks", "ACTIVE TASKS", "Active Tasks"), ("Task History", "TASK HISTORY", "Task History"), ("Auto Income", "AUTO INCOME", "Auto Income")]},
    {"name": "CORE", "desc": "CORE MODE — システムの進化（自己改変）と、環境設定を管理します。",
     "rooms": [("Evolution", "EVOLUTION", "Core Upgrade"), ("Settings", "SETTINGS", "Settings")]},
]

# --- 状態初期化 ---
if "hub_browse_index" not in st.session_state: st.session_state.hub_browse_index = 0
if "hub_active_mode" not in st.session_state: st.session_state.hub_active_mode = MODES[0]["name"]
if "global_chat_history" not in st.session_state: st.session_state.global_chat_history = []
if "ai_voice_base64" not in st.session_state: st.session_state.ai_voice_base64 = None
if "just_generated_audio" not in st.session_state: st.session_state.just_generated_audio = False
if "pending_action" not in st.session_state: st.session_state.pending_action = None

v_data = st.session_state.ai_voice_base64 if st.session_state.ai_voice_base64 else ""
autoplay_attr = "autoplay" if st.session_state.just_generated_audio else ""
st.session_state.just_generated_audio = False

# --- ロゴ（アイコン＋ワードマーク） ---
if "icon_b64" not in st.session_state:
    st.session_state.icon_b64 = get_base64_video("assets/aibou_icon.png") or ""
if st.session_state.icon_b64:
    st.markdown(
        f"""<div class="forge-logo-wrap">
              <img src="data:image/png;base64,{st.session_state.icon_b64}">
              <h2 class="hub-title">THE FORGE OS</h2>
            </div>""",
        unsafe_allow_html=True,
    )
else:
    st.markdown("<h2 class='hub-title' style='text-align:center;'>⬡ THE FORGE OS</h2>", unsafe_allow_html=True)

# --- コア（主役）を中央に鎮座 ---
core_height = 300
_cl, _cc, _cr = st.columns([1, 2, 1])
with _cc:
    core_html = (MASTER_CORE_TEMPLATE
                 .replace("H_VAL", str(core_height)).replace("MAX_Wpx", "300")
                 .replace("V_DATA", v_data).replace("A_PLAY", autoplay_attr))
    st.components.v1.html(core_html, height=core_height + 20)

# --- 確定中モードの説明＋部屋カード（コマンドデッキ直上に展開） ---
_active = next((m for m in MODES if m["name"] == st.session_state.hub_active_mode), MODES[0])
st.markdown(f"<div class='mode-desc'>{_active['desc']}</div>", unsafe_allow_html=True)

_cards = "".join(
    f"<a class='mode-card' href='?goto={target.replace(' ', '%20')}' target='_self'>"
    f"<div class='mc-name'>{disp}</div><div class='mc-sub'>{sub}</div></a>"
    for disp, sub, target in _active["rooms"]
)
st.markdown(f"<div class='room-grid'>{_cards}</div>", unsafe_allow_html=True)

# --- コマンドデッキ：◀ ❖ モード名 ▶ カルーセル ---
_browse = MODES[st.session_state.hub_browse_index]
b1, b2, b3 = st.columns([1, 2, 1])
if b1.button("◀", key="mode_prev", use_container_width=True):
    st.session_state.hub_browse_index = (st.session_state.hub_browse_index - 1) % len(MODES)
    st.rerun()
if b2.button(f"❖  {_browse['name']}", key="mode_confirm", use_container_width=True):
    # 確定：アクティブモードを切替＋システムボイス（コアが波形で発光）
    st.session_state.hub_active_mode = _browse["name"]
    try:
        _tts = gTTS(text=_browse["name"], lang="en")
        _buf = io.BytesIO(); _tts.write_to_fp(_buf)
        st.session_state.ai_voice_base64 = base64.b64encode(_buf.getvalue()).decode()
        st.session_state.just_generated_audio = True
    except Exception:
        pass
    st.rerun()
if b3.button("▶", key="mode_next", use_container_width=True):
    st.session_state.hub_browse_index = (st.session_state.hub_browse_index + 1) % len(MODES)
    st.rerun()

if _browse["name"] != st.session_state.hub_active_mode:
    st.markdown(
        f"<div class='mode-active-hint'>◀ ▶ 選択中: <b>{_browse['name']}</b> ／ ❖ を押して確定</div>",
        unsafe_allow_html=True,
    )

# --- AI会話履歴 ---
if st.session_state.global_chat_history:
    with st.container(height=240, border=False):
        for m in st.session_state.global_chat_history:
            with st.chat_message(m["role"], avatar=m.get("avatar", "🤖")):
                st.markdown(m["content"])

# ------------------------------------------
# 🚨 承認ゲート（外部に作用する操作）・マイク・AIチャット処理
# ------------------------------------------
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
    iframe[title*='mic'] { mix-blend-mode: screen !important; opacity: 0.8; transition: all 0.3s ease-in-out; }
    iframe[title*='mic']:hover { opacity: 1.0; filter: drop-shadow(0px 5px 15px rgba(102, 252, 241, 0.5)); transform: translateY(-2px); }
    [data-testid='stVerticalBlock'] > div:has(iframe[title*='mic']) { margin-bottom: -25px !important; position: relative; z-index: 50; }
    </style>
""", unsafe_allow_html=True)

col1, col2, col3 = st.columns([4, 4, 4])
with col2:
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
            # 🤖 エージェント本体：マルチAI＋ツール実行（承認が必要な操作は pending に）
            ai_text, _updated, pending = run_agent(last_prompt, prior_history)
            if pending:
                st.session_state.pending_action = pending

            st.markdown(ai_text)

            # 🔊 音声読み上げ（ネットワーク不調でも落ちないよう保護）
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
