if "evolution_code" not in st.session_state: st.session_state.evolution_code = ""
if "evolution_log" not in st.session_state: st.session_state.evolution_log = ""

# 🚨 ターゲットを core.py に変更
try:
    with open("core.py", "r", encoding="utf-8") as f:
        current_app_code = f.read()
except Exception as e:
    current_app_code = f"# ERROR: {e}"

col_left, col_right = st.columns(2, gap="large")

with col_left:
    st.markdown("<h2 style='color: #2b6cb0; font-weight: 800; letter-spacing: 2px;'>[ PROJECT EVOLUTION ]</h2>", unsafe_allow_html=True)
    st.caption("/// WARNING: CORE SYSTEM OVERRIDE PROTOCOL ///")
    room_help("Core Upgrade")
    model_choice = st.radio("ENGINE CLASS:", ["[ STANDARD ] Gemini Flash", "[ ADVANCED ] Gemini Pro"], index=0, horizontal=True, label_visibility="collapsed")
    
    with st.expander("> CURRENT_CORE.py", expanded=False):
        st.code(current_app_code, language="python")

    if st.session_state.evolution_log:
        st.markdown("<br><p style='font-weight:bold; color:#718096;'>[ EVOLUTION REPORT ]</p>", unsafe_allow_html=True)
        with st.container(border=True):
            st.markdown(st.session_state.evolution_log)

with col_right:
    st.markdown("<p style='font-weight:bold; color:#718096;'>[ INPUT DIRECTIVE ]</p>", unsafe_allow_html=True)
    upgrade_prompt = st.text_area("COMMAND:", placeholder="例：OSのテーマカラーを赤ベースに変更せよ。", height=100, label_visibility="collapsed")
    
    if st.button("[ INITIATE EVOLUTION ]", use_container_width=True):
        if upgrade_prompt:
            target_model = 'gemini-2.5-pro' if "Pro" in model_choice else 'gemini-2.5-flash'
            
            with st.spinner(f"Processing with {target_model}..."):
                try:
                    # 🚨 AIにターゲットを教育（省略厳禁プロンプト復旧）
                    system_prompt = """
                    あなたは自分自身（Streamlitアプリ）のソースコードを書き換えるAIアーキテクトです。
                    現在、システムはデュアルコア構成（app.pyがランチャー、core.pyが本体）になっています。
                    あなたは【core.py】を改修します。
                    
                    【厳格な出力フォーマット】
                    必ず以下の2つのセクションに分けて出力すること。これ以外の余計な挨拶などは一切不要。

                    [CHANGELOG]
                    （ここに、どこを・なぜ・どのように改修したのか、簡潔な箇条書きでレポートを記載する）

                    [CODE]
                    ```python
                    （ここに、1行目から最終行まで、絶対に省略せず完全な core.py のソースコードを記載する）
                    ```
                    
                    【絶対遵守ルール】
                    1. コードの省略（# ...既存のコードと同じ... 等）はアプリを破壊するため【絶対禁止】。
                    2. ユーザーの指示箇所以外の既存機能は1ミリも変更・破損させないこと。
                    3. インデントを正確に保ち、Syntax Errorを絶対に出さないこと。
                    """
                    # 🤖 マルチAI対応：get_ai_response 経由で呼び出す
                    ai_text = get_ai_response(system_prompt + f"\n\n【指示】\n{upgrade_prompt}\n\n【現状の core.py】\n```python\n{current_app_code}\n```", model=target_model)

                    log_match = re.search(r'\[CHANGELOG\](.*?)\[CODE\]', ai_text, re.DOTALL)
                    code_match = re.search(r'```python\n(.*?)\n```', ai_text, re.DOTALL)
                    
                    if code_match and log_match:
                        st.session_state.evolution_log = log_match.group(1).strip()
                        st.session_state.evolution_code = code_match.group(1)
                        st.rerun()
                    else:
                        st.error("OUTPUT ERROR: 出力フォーマット崩れ。再度実行してください。")
                except Exception as e:
                    st.error(f"SYSTEM ERROR: {e}")

    if st.session_state.evolution_code:
        st.markdown("<br><p style='font-weight:bold; color:#00f3ff;'>[ EVOLVED CORE GENERATED ]</p>", unsafe_allow_html=True)
        with st.expander("> NEW_CORE.py (Hover top-right to copy)", expanded=True):
            st.code(st.session_state.evolution_code, language="python")
        
        st.download_button(
            label="[ MANUAL BACKUP DOWNLOAD ]",
            data=st.session_state.evolution_code,
            file_name="core_evolved.py",
            mime="text/plain",
            use_container_width=True
        )
        
        st.markdown("<br>", unsafe_allow_html=True)
        st.warning("/// LOCAL DANGER: 手元のPCの core.py を直接上書きして再起動します。")
        if st.button("!!! LOCAL OVERRIDE !!!", use_container_width=True, type="primary"):
            try:
                # 🚨 【追加】上書き前に自動バックアップ（過去5個まで保持）
                import glob
                os.makedirs("backups", exist_ok=True)
                backup_time = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                with open("core.py", "r", encoding="utf-8") as f: old_code = f.read()
                with open(f"backups/core_backup_{backup_time}.py", "w", encoding="utf-8") as f: f.write(old_code)
                
                # 過去5個を超えたら古いものを削除
                backup_files = sorted(glob.glob("backups/core_backup_*.py"))
                if len(backup_files) > 5:
                    for old_file in backup_files[:-5]:
                        os.remove(old_file)

                # 新しいコードで上書き
                with open("core.py", "w", encoding="utf-8") as f:
                    f.write(st.session_state.evolution_code)
                st.success("LOCAL OVERRIDE COMPLETE. REBOOTING...")
                st.session_state.evolution_code = ""; st.session_state.evolution_log = ""; st.rerun()
            except Exception as e:
                st.error(f"LOCAL OVERRIDE FAILED: {e}")
        
        st.markdown("<br>", unsafe_allow_html=True)
        st.info("☁️ CLOUD DEPLOY: GitHub上の core.py をAPIで書き換え、クラウド環境を再デプロイします。")
        if st.button("🚀 GITHUB AUTO DEPLOY", use_container_width=True):
            gh_token = st.session_state.global_api_keys.get("gh_token", "")
            gh_owner = st.session_state.global_api_keys.get("gh_owner", "")
            gh_repo = st.session_state.global_api_keys.get("gh_repo", "")
            
            if not all([gh_token, gh_owner, gh_repo]):
                st.error("🚨 Vault（保管庫）にGitHub連携のキーが登録されていません。")
            else:
                with st.spinner("Deploying to GitHub..."):
                    try:
                        url = f"https://api.github.com/repos/{gh_owner}/{gh_repo}/contents/core.py"
                        headers = {"Authorization": f"token {gh_token}", "Accept": "application/vnd.github.v3+json"}
                        res = requests.get(url, headers=headers)
                        sha = res.json().get('sha', '') if res.status_code == 200 else ''
                        encoded_content = base64.b64encode(st.session_state.evolution_code.encode('utf-8')).decode('utf-8')
                        data = {"message": "AI Auto Evolution: SYSTEM OVERRIDE", "content": encoded_content}
                        if sha: data["sha"] = sha
                        put_res = requests.put(url, headers=headers, json=data)
                        
                        if put_res.status_code in [200, 201]:
                            st.success("🚀 DEPLOY COMPLETE!")
                            st.session_state.evolution_code = ""; st.session_state.evolution_log = ""
                        else:
                            st.error(f"DEPLOY FAILED: {put_res.json()}")
                    except Exception as e:
                        st.error(f"API ERROR: {e}")