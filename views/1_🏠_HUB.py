# views/1_🏠_HUB.py — THE FORGE OS / コマンドデッキ
# レイアウト（縦圧縮）：ロゴ → 小さなカルーセル(◀ ❖ MODE ▶) → コア → コマンド入力。
# モードを選ぶとコアの「左右」に入口ボタン（白背景・黒文字）＋短い説明が出る。
# 入口ボタンはクリックで直接そのモードへ（?goto=）。AIコンソールは保持。
# 配色・カード等は assets/style.css（core.py が全ページに適用）。

# --- モード定義は core.py の FORGE_MODES を共用（HUB＆サイドバーで一貫） ---
# 既定は先頭の CORE（メイン司令塔＝コアとの対話モード）。
MODES = FORGE_MODES

# --- 状態初期化 ---
if "hub_mode_index" not in st.session_state: st.session_state.hub_mode_index = 0
if "global_chat_history" not in st.session_state: st.session_state.global_chat_history = []
if "ai_voice_base64" not in st.session_state: st.session_state.ai_voice_base64 = None
if "just_generated_audio" not in st.session_state: st.session_state.just_generated_audio = False
if "pending_action" not in st.session_state: st.session_state.pending_action = None

v_data = st.session_state.ai_voice_base64 if st.session_state.ai_voice_base64 else ""
autoplay_attr = "autoplay" if st.session_state.just_generated_audio else ""
st.session_state.just_generated_audio = False

# --- ① ロゴ（上部・小マージン） ---
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

# --- ② 小さなカルーセル：◀ ❖ MODE ▶（ロゴ直下・中央寄せ） ---
_n = len(MODES)
_cs = st.columns([2, 1, 1.6, 1, 2])
if _cs[1].button("◀", key="mode_prev", use_container_width=True):
    st.session_state.hub_mode_index = (st.session_state.hub_mode_index - 1) % _n
    st.rerun()
_mode = MODES[st.session_state.hub_mode_index]
if _cs[2].button(f"❖  {_mode['name']}", key="mode_voice", use_container_width=True):
    # システムボイス（コアが波形に合わせて発光）
    try:
        _tts = gTTS(text=_mode["name"], lang="en")
        _buf = io.BytesIO(); _tts.write_to_fp(_buf)
        st.session_state.ai_voice_base64 = base64.b64encode(_buf.getvalue()).decode()
        st.session_state.just_generated_audio = True
    except Exception:
        pass
    st.rerun()
if _cs[3].button("▶", key="mode_next", use_container_width=True):
    st.session_state.hub_mode_index = (st.session_state.hub_mode_index + 1) % _n
    st.rerun()

# --- モードの簡単な説明 ---
st.markdown(f"<div class='mode-desc'>{_mode['desc']}</div>", unsafe_allow_html=True)


# --- ③ コア（主役）を中央に、左右に入口ボタン（権限で出し分け） ---
# 入口は st.button（再実行のみ＝ページ再読込なし）。以前の <a href="?goto="> は
# 全体リロードを起こしてセッション(ログイン状態)を失うため廃止。
_is_owner = (not globals().get("AUTH_ON")) or bool(globals().get("auth") and auth.is_owner())
_income_ok = (not globals().get("AUTH_ON")) or bool(globals().get("auth") and auth.income_active())
_rooms = []
for _disp, _sub, _target in _mode["rooms"]:
    if _target == "Core Upgrade" and not _is_owner:
        continue  # 自己進化はオーナー専用
    if _target == "Auto Income" and not _income_ok:
        _disp = "🔒 " + _disp
    _rooms.append((_disp, _target))
_half = (len(_rooms) + 1) // 2
_left, _right = _rooms[:_half], _rooms[_half:]


def _room_buttons(rooms, side):
    st.markdown("<div style='height:70px'></div>", unsafe_allow_html=True)  # コアと縦位置を合わせる
    for _disp, _target in rooms:
        if st.button(_disp, key=f"room_{side}_{_target}", use_container_width=True):
            st.session_state.current_mode = _target
            st.rerun()


col_l, col_c, col_r = st.columns([1.1, 1.7, 1.1])
with col_l:
    _room_buttons(_left, "L")
with col_c:
    core_height = 240
    core_html = (MASTER_CORE_TEMPLATE
                 .replace("H_VAL", str(core_height)).replace("MAX_Wpx", "260")
                 .replace("V_DATA", v_data).replace("A_PLAY", autoplay_attr))
    st.components.v1.html(core_html, height=core_height + 20)
with col_r:
    _room_buttons(_right, "R")

# --- AI会話履歴（あればコンパクト表示） ---
if st.session_state.global_chat_history:
    with st.container(height=200, border=False):
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

# 🎙️ 音声入力（旧コンポーネント）は安定性のため既定オフ。ボタンで明示的に有効化。
if "mic_enabled" not in st.session_state:
    st.session_state.mic_enabled = False
spoken_text = None
col1, col2, col3 = st.columns([4, 4, 4])
with col2:
    if st.session_state.mic_enabled:
        try:
            spoken_text = speech_to_text(language='ja', start_prompt="◈ PUSH TO TALK", stop_prompt="⬡ TAP TO SEND", use_container_width=True, just_once=True, key='STT')
        except Exception:
            spoken_text = None
    else:
        if st.button("🎙️ 音声入力をON", use_container_width=True, key="mic_enable_btn"):
            st.session_state.mic_enabled = True
            st.rerun()

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
            ai_text, _updated, pending = run_agent(last_prompt, prior_history)
            if pending:
                st.session_state.pending_action = pending

            st.markdown(ai_text)

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
