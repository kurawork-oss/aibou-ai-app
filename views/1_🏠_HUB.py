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

# --- 左上 ON/OFF インジケータ（中心核GeminiのAPIキー保存でONLINE） ---
_gem_on = bool((st.session_state.get("global_api_keys") or {}).get("gemini")) or bool(get_secret("GEMINI_API_KEY"))
_ol_txt, _ol_cls = ("ONLINE", "on") if _gem_on else ("OFFLINE", "off")
st.markdown(f"""
<div class="forge-online forge-online-{_ol_cls}"><span class="dot"></span>{_ol_txt}</div>
<style>
.forge-online {{ position:fixed; top:12px; left:16px; z-index:1000; font-family:'Share Tech Mono',monospace;
    font-size:11px; letter-spacing:2px; font-weight:800; display:flex; align-items:center; gap:7px; }}
.forge-online .dot {{ width:8px; height:8px; border-radius:50%; }}
.forge-online-on {{ color:#eaf4ff; }}
.forge-online-on .dot {{ background:#cfe9ff; box-shadow:0 0 10px 2px rgba(150,200,255,0.85); animation: ol-pulse 2.4s ease-in-out infinite; }}
.forge-online-off {{ color:#6b6f76; }}
.forge-online-off .dot {{ background:#444; }}
@keyframes ol-pulse {{ 0%,100%{{opacity:.6}} 50%{{opacity:1}} }}
</style>
""", unsafe_allow_html=True)

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


# コア設定の状態を先に初期化（col_c のポップオーバーで使用）
for _k, _v in {"show_chat_input": True, "mic_enabled": False, "voice_enabled": True, "voice_slow": False}.items():
    if _k not in st.session_state:
        st.session_state[_k] = _v

col_l, col_c, col_r = st.columns([1.1, 1.7, 1.1])
with col_l:
    _room_buttons(_left, "L")
with col_c:
    render_core(240)
    # AI音声（生成時のみネイティブ再生）
    if st.session_state.get("ai_voice_base64") and autoplay_attr:
        try:
            st.audio(base64.b64decode(st.session_state.ai_voice_base64), format="audio/mp3", autoplay=True)
        except Exception:
            pass
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

# 🎙️ 音声入力（コア設定でON/OFF。既定オフ＝安定）。ONのときだけコンポーネントを描画。
spoken_text = None
if st.session_state.get("mic_enabled"):
    _m1, _m2, _m3 = st.columns([4, 4, 4])
    with _m2:
        try:
            spoken_text = speech_to_text(language='ja', start_prompt="◈ PUSH TO TALK", stop_prompt="⬡ TAP TO SEND", use_container_width=True, just_once=True, key='STT')
        except Exception:
            spoken_text = None

if not st.session_state.pending_action:
    if spoken_text:
        st.session_state.global_chat_history.append({"role": "user", "avatar": "👤", "content": spoken_text})
        st.rerun()

    if st.session_state.get("show_chat_input", True):
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
            try:
                import commands as _cmds
            except Exception:
                _cmds = None
            _is_cmd = bool(_cmds and _cmds.is_command(last_prompt))
            pending = None
            if _is_cmd:
                # "/" 始まりはアプリ専用コマンドとして即実行（run_agent を介さない）
                ai_text = _cmds.handle(last_prompt)
                if ai_text == "__CLEAR__":
                    st.session_state.global_chat_history = []
                    st.rerun()
            else:
                ai_text, _updated, pending = run_agent(last_prompt, prior_history)
                if pending:
                    st.session_state.pending_action = pending

            st.markdown(ai_text)

            # 読み上げ（コマンド応答は読み上げない）
            if (not _is_cmd) and st.session_state.get("voice_enabled", True):
                try:
                    clean_text = ai_text.replace("*", "").replace("#", "").replace("`", "").replace("_", "")
                    if clean_text.strip():
                        tts = gTTS(text=clean_text[:200], lang='ja', slow=st.session_state.get("voice_slow", False))
                        audio_fp = io.BytesIO()
                        tts.write_to_fp(audio_fp)
                        st.session_state.ai_voice_base64 = base64.b64encode(audio_fp.getvalue()).decode()
                        st.session_state.just_generated_audio = True
                except Exception:
                    pass

            st.session_state.global_chat_history.append({"role": "assistant", "avatar": "◈", "content": ai_text})
            st.rerun()
