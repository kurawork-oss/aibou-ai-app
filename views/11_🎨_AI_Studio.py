# views/11_🎨_AI_Studio.py — STUDIO：自分専用AIを作る（Dify風・チャット型 v1）
# core.py の exec() で読み込まれ、st / load_vault / save_vault / agent /
# get_ai_response はグローバルから利用できる。
# カスタムAIは Vault（暗号化・アカウント毎）に保存。人格(プロンプト)を毎回参照して応答する。
import uuid

st.markdown("<h2 class='cyber-title'>🎨 AI STUDIO</h2>", unsafe_allow_html=True)
st.caption("/// 自分専用AIを作成 — 人格(プロンプト)・モデル・APIを設定し、その設定を毎回参照する専用AIとして使う ///")

_vault = load_vault() or {}
_ais = list(_vault.get("custom_ais", []) or [])


def _save_ais(ais):
    v = load_vault() or {}
    v["custom_ais"] = ais
    ok = save_vault(v)
    if ok:
        st.session_state.custom_ais = ais  # コア(ask_custom_ai)が参照する最新一覧
    return ok


if "studio_sel" not in st.session_state:
    st.session_state.studio_sel = (_ais[0]["id"] if _ais else None)
if "studio_edit" not in st.session_state:
    st.session_state.studio_edit = bool(not _ais)

col_list, col_main = st.columns([3, 7], gap="large")

with col_list:
    st.markdown("**🤖 マイAI**")
    if not _ais:
        st.caption("まだありません。➕ から作成。")
    for a in _ais:
        _label = ("● " if a["id"] == st.session_state.studio_sel else "🤖 ") + a.get("name", "(無名)")
        if st.button(_label, key=f"selai_{a['id']}", use_container_width=True):
            st.session_state.studio_sel = a["id"]
            st.session_state.studio_edit = False
            st.rerun()
    st.markdown("---")
    if st.button("➕ 新規AIを作成", use_container_width=True):
        st.session_state.studio_sel = None
        st.session_state.studio_edit = True
        st.rerun()

with col_main:
    sel = next((a for a in _ais if a["id"] == st.session_state.studio_sel), None)

    # --- 作成 / 編集フォーム ---
    if st.session_state.studio_edit or sel is None:
        st.markdown("#### ⚙️ AIの設定")
        _e = sel or {}
        _provs = ["gemini", "claude", "grok", "openai"]
        name = st.text_input("名前", value=_e.get("name", ""), placeholder="例：法務アシスタント")
        prompt = st.text_area(
            "人格・指示（このAIが毎回参照する。CLAUDE.md的）",
            value=_e.get("prompt", ""), height=200,
            placeholder="例：あなたは丁寧で正確な法務アシスタント。日本法に基づき、断定を避け、根拠条文を添える。…",
        )
        rules = st.text_area(
            "ルール（箇条書き・常に厳守。人格とは別の絶対条件）",
            value=_e.get("rules", ""), height=110,
            placeholder="・必ず日本語で回答\n・推測は『推測』と明示\n・社外秘は出力しない",
        )
        c1, c2 = st.columns(2)
        provider = c1.selectbox("プロバイダ", _provs,
                                index=_provs.index(_e.get("provider", "gemini")) if _e.get("provider", "gemini") in _provs else 0)
        model = c2.text_input("モデル（任意）", value=_e.get("model", ""), placeholder="空欄で既定")
        api_key = st.text_input("専用APIキー（任意・暗号化保存）", value=_e.get("api_key", ""), type="password",
                                placeholder="空欄ならVaultの共通キーを使用")
        st.caption("※ 専用APIキーは他の鍵と同様、Vaultに暗号化して保存されます（アカウント毎）。")
        b1, b2 = st.columns(2)
        if b1.button("💾 保存", type="primary", use_container_width=True):
            if not name.strip():
                st.error("名前を入力してください。")
            else:
                if sel:
                    sel.update({"name": name, "prompt": prompt, "rules": rules,
                                "provider": provider, "model": model, "api_key": api_key})
                else:
                    nid = uuid.uuid4().hex[:8]
                    _ais.append({"id": nid, "name": name, "prompt": prompt, "rules": rules,
                                 "provider": provider, "model": model, "api_key": api_key})
                    st.session_state.studio_sel = nid
                if _save_ais(_ais):
                    st.session_state.studio_edit = False
                    st.success("保存しました。")
                    st.rerun()
                else:
                    st.error("保存に失敗しました（DB接続を確認）。")
        if sel and b2.button("🗑️ 削除", use_container_width=True):
            _ais = [a for a in _ais if a["id"] != sel["id"]]
            _save_ais(_ais)
            st.session_state.studio_sel = (_ais[0]["id"] if _ais else None)
            st.session_state.studio_edit = False
            st.rerun()

    # --- チャット ---
    elif sel:
        h1, h2 = st.columns([7, 3])
        h1.markdown(f"#### 💬 {sel.get('name')}")
        if h2.button("⚙️ 編集", use_container_width=True):
            st.session_state.studio_edit = True
            st.rerun()
        st.caption(f"provider: {sel.get('provider', 'gemini')} / model: {sel.get('model') or '既定'} / "
                   f"専用キー: {'あり' if sel.get('api_key') else 'Vault共通'}")

        hkey = f"studio_chat_{sel['id']}"
        if hkey not in st.session_state:
            st.session_state[hkey] = []
        with st.container(height=380, border=True):
            for m in st.session_state[hkey]:
                with st.chat_message(m["role"], avatar=("🧑" if m["role"] == "user" else "🤖")):
                    st.markdown(m["content"])
        cc1, cc2 = st.columns([8, 2])
        if cc2.button("🧹 クリア", use_container_width=True):
            st.session_state[hkey] = []
            st.rerun()
        if msg := st.chat_input(f"{sel.get('name')} に話しかける", key=f"studio_in_{sel['id']}"):
            st.session_state[hkey].append({"role": "user", "content": msg})
            _sys = sel.get("prompt", "") + (("\n\n【厳守ルール】\n" + sel["rules"]) if sel.get("rules") else "")
            convo = ([{"role": "system", "content": _sys}]
                     + [{"role": x["role"], "content": x["content"]} for x in st.session_state[hkey]])
            with st.spinner("..."):
                try:
                    reply = agent.direct_chat(convo, provider=sel.get("provider"),
                                              api_key=(sel.get("api_key") or None), model=(sel.get("model") or None))
                except Exception:
                    reply = get_ai_response(convo)
            st.session_state[hkey].append({"role": "assistant", "content": reply})
            st.rerun()
    else:
        st.info("左の『➕ 新規AIを作成』から、自分専用AIを作りましょう。")
