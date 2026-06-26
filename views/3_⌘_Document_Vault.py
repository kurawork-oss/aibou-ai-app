if "vault_notebooks" not in st.session_state:
    st.session_state.vault_notebooks = vault_get("notebooks", {}) or {}  # Vault(Supabase)から復元
if "current_vault_nb" not in st.session_state:
    st.session_state.current_vault_nb = None

def _save_notebooks():
    """ノート（資料＋チャット）をVault(Supabase)に永続化する。再起動でも残す。"""
    persist_vault_key("notebooks", st.session_state.vault_notebooks)

if st.session_state.current_vault_nb is None:
    st.markdown("<h2 class='cyber-title'>⌘ DOCUMENT VAULT</h2>", unsafe_allow_html=True)
    room_help("Document Vault")
    st.caption("資料保管庫（ノートブック）を選択、または新規作成してください。")
    
    items = ["__NEW__"] + list(st.session_state.vault_notebooks.keys())
    for i in range(0, len(items), 3):
        cols = st.columns(3)
        for j in range(3):
            if i + j < len(items):
                nb_name = items[i + j]
                with cols[j]:
                    if nb_name == "__NEW__":
                        with st.container(border=True):
                            st.markdown("<h4 style='text-align:center; color:#00f3ff; font-weight:800;'>⬡ NEW VAULT</h4>", unsafe_allow_html=True)
                            new_nb_name = st.text_input("Vault Name", key="new_nb_name", label_visibility="collapsed", placeholder="New Vault Name...")
                            if st.button("INITIALIZE ⚡", key="create_nb", use_container_width=True):
                                if new_nb_name and new_nb_name not in st.session_state.vault_notebooks:
                                    st.session_state.vault_notebooks[new_nb_name] = {"docs": {}, "chat": []}
                                    st.session_state.current_vault_nb = new_nb_name
                                    _save_notebooks()
                                    st.rerun()
                    else:
                        with st.container(border=True):
                            st.markdown(f"<h4 style='color:#1a202c; font-weight:bold;'>⌘ {nb_name}</h4>", unsafe_allow_html=True)
                            doc_count = len(st.session_state.vault_notebooks[nb_name]['docs'])
                            st.markdown(f"<p style='font-size: 12px; color: #718096;'><span class='status-dot'>●</span>SECURED | Docs: {doc_count}</p>", unsafe_allow_html=True)
                            
                            c1, c2 = st.columns([7, 3])
                            with c1:
                                if st.button("ACCESS ➔", key=f"open_nb_{nb_name}", use_container_width=True):
                                    st.session_state.current_vault_nb = nb_name
                                    st.rerun()
                            with c2:
                                if st.button("DEL", key=f"del_nb_{nb_name}", use_container_width=True):
                                    del st.session_state.vault_notebooks[nb_name]
                                    _save_notebooks()
                                    st.rerun()

else:
    nb_name = st.session_state.current_vault_nb
    nb_data = st.session_state.vault_notebooks[nb_name]
    
    if st.button("⬅ RETURN TO VAULT INDEX"):
        st.session_state.current_vault_nb = None
        st.rerun()

    st.markdown(f"<h2 class='cyber-title'>⌘ VAULT : {nb_name}</h2>", unsafe_allow_html=True)
    
    col_log, col_preview = st.columns([7, 3])

    with col_log:
        st.markdown("<p style='font-weight:bold; color:#718096;'>[ VAULT CONCIERGE ]</p>", unsafe_allow_html=True)
        with st.container(height=450, border=False):
            if not nb_data["chat"]:
                st.info("資料をアップロードし、質問してください。")
            for m in nb_data["chat"]:
                with st.chat_message(m["role"], avatar="👤" if m["role"]=="user" else "🤖"):
                    st.markdown(m["content"])

        if prompt := st.chat_input("この資料について質問する...", key="vault_chat_input"):
            nb_data["chat"].append({"role": "user", "avatar": "👤", "content": prompt})
            with st.spinner("知識を抽出中..."):
                try:
                    if not nb_data["docs"]:
                        response_text = "資料がありません。右のパネルからアップロードしてください。"
                    else:
                        all_context = "\n\n=== 資料 ===\n" + "\n---\n".join([f"【{fname}】\n{content}" for fname, content in nb_data["docs"].items()])
                        system_instruction = f"専属コンシェルジュとして、以下の資料【のみ】に基づいて回答せよ。\n{all_context}"
                        # 🤖 マルチAI対応：get_ai_response 経由で呼び出す
                        response_text = get_ai_response(system_instruction + "\n質問: " + prompt, model='gemini-2.5-flash')
                    nb_data["chat"].append({"role": "assistant", "avatar": "🤖", "content": response_text})
                    _save_notebooks()
                    st.rerun()
                except Exception as e:
                    st.error(f"解析エラー: {e}")

    with col_preview:
        render_core(150)
        st.markdown("<p style='font-weight:bold; color:#718096;'>[ MATERIAL MANAGEMENT ]</p>", unsafe_allow_html=True)
        with st.container(border=True):
            st.markdown("#### 📥 UPLOAD DATA (PDF, TXT, MD)")
            uploaded_files = st.file_uploader("ファイルをドロップ", type=["txt", "md", "pdf"], accept_multiple_files=True, label_visibility="collapsed")
            if st.button("STORE IN VAULT ⚡", use_container_width=True):
                if uploaded_files:
                    for uf in uploaded_files:
                        if uf.name not in nb_data["docs"]:
                            if uf.name.lower().endswith('.pdf'):
                                pdf_text = "".join([page.extract_text() + "\n" for page in pypdf.PdfReader(uf).pages])
                                nb_data["docs"][uf.name] = pdf_text
                            else:
                                nb_data["docs"][uf.name] = io.StringIO(uf.getvalue().decode("utf-8")).read()
                    _save_notebooks()
                    st.rerun()

        if nb_data["docs"]:
            st.markdown(f"#### 🧠 STORED DATA ({len(nb_data['docs'])} files)")
            for fname in list(nb_data["docs"].keys()):
                with st.expander(f"📄 {fname}", expanded=False):
                    st.code(nb_data["docs"][fname][:200] + "...", language="text")
                    if st.button(f"DELETE", key=f"del_{fname}", use_container_width=True):
                        del nb_data["docs"][fname]
                        _save_notebooks()
                        st.rerun()