# views/11_🎨_AI_Studio.py — STUDIO：自分専用AIを作る（Dify風）
#   タブ1「🤖 マイAI」：人格/ルール/モデル/専用APIを設定して保存し、その設定を毎回参照してチャット。
#   タブ2「🔧 ワークフロー」：複数ステップを連鎖実行（各ステップにAIと指示を割当）＝自動化。
# core.py の exec() で読み込まれ、st / load_vault / save_vault / agent /
# get_ai_response はグローバルから利用できる。データは Vault（暗号化・アカウント毎）に保存。
import uuid

st.markdown("<h2 class='cyber-title'>🎨 AI STUDIO</h2>", unsafe_allow_html=True)
st.caption("/// 自分専用AIを作成し、複数AIを連鎖させて自動化する（Dify風） ///")
db_warning()  # DB未接続だと作成したAI/ワークフローは保存されないため警告

_vault = load_vault() or {}
_ais = list(_vault.get("custom_ais", []) or [])
_wfs = list(_vault.get("workflows", []) or [])


def _save_ais(ais):
    v = load_vault() or {}
    v["custom_ais"] = ais
    ok = save_vault(v)
    if ok:
        st.session_state.custom_ais = ais  # コア(ask_custom_ai)が参照する最新一覧
    return ok


def _save_wfs(wfs):
    v = load_vault() or {}
    v["workflows"] = wfs
    return save_vault(v)


def _ai_by_name(name):
    return next((a for a in _ais if a.get("name") == name), None)


def _sysmsg(ai):
    if not ai:
        return ""
    return ai.get("prompt", "") + (("\n\n【厳守ルール】\n" + ai["rules"]) if ai.get("rules") else "")


tab_ai, tab_wf = st.tabs(["🤖 マイAI", "🔧 ワークフロー"])

# =====================================================================
# 🤖 マイAI（作成・編集・チャット）
# =====================================================================
with tab_ai:
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
            if b1.button("💾 保存", type="primary", use_container_width=True, key="ai_save"):
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
            if sel and b2.button("🗑️ 削除", use_container_width=True, key="ai_del"):
                _ais = [a for a in _ais if a["id"] != sel["id"]]
                _save_ais(_ais)
                st.session_state.studio_sel = (_ais[0]["id"] if _ais else None)
                st.session_state.studio_edit = False
                st.rerun()

        elif sel:
            h1, h2 = st.columns([7, 3])
            h1.markdown(f"#### 💬 {sel.get('name')}")
            if h2.button("⚙️ 編集", use_container_width=True, key="ai_edit"):
                st.session_state.studio_edit = True
                st.rerun()
            st.caption(f"provider: {sel.get('provider', 'gemini')} / model: {sel.get('model') or '既定'} / "
                       f"専用キー: {'あり' if sel.get('api_key') else 'Vault共通'}")

            hkey = f"studio_chat_{sel['id']}"
            if hkey not in st.session_state:
                st.session_state[hkey] = []
            with st.container(height=360, border=True):
                for m in st.session_state[hkey]:
                    with st.chat_message(m["role"], avatar=("🧑" if m["role"] == "user" else "🤖")):
                        st.markdown(m["content"])
            if st.button("🧹 会話クリア", key="ai_clear"):
                st.session_state[hkey] = []
                st.rerun()
            if msg := st.chat_input(f"{sel.get('name')} に話しかける", key=f"studio_in_{sel['id']}"):
                st.session_state[hkey].append({"role": "user", "content": msg})
                convo = ([{"role": "system", "content": _sysmsg(sel)}]
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

# =====================================================================
# 🔧 ワークフロー（複数ステップ連鎖＝自動化。前段の出力が次段の入力になる）
# =====================================================================
with tab_wf:
    if "wf_sel" not in st.session_state:
        st.session_state.wf_sel = (_wfs[0]["id"] if _wfs else None)
    if "wf_edit" not in st.session_state:
        st.session_state.wf_edit = bool(not _wfs)

    _ai_opts = ["(コア既定)"] + [a.get("name", "") for a in _ais]
    wcol_list, wcol_main = st.columns([3, 7], gap="large")

    with wcol_list:
        st.markdown("**🔧 ワークフロー**")
        if not _wfs:
            st.caption("まだありません。➕ から作成。")
        for w in _wfs:
            _wl = ("● " if w["id"] == st.session_state.wf_sel else "🔧 ") + w.get("name", "(無名)")
            if st.button(_wl, key=f"selwf_{w['id']}", use_container_width=True):
                st.session_state.wf_sel = w["id"]
                st.session_state.wf_edit = False
                st.rerun()
        st.markdown("---")
        if st.button("➕ 新規ワークフロー", use_container_width=True):
            st.session_state.wf_sel = None
            st.session_state.wf_edit = True
            st.rerun()

    with wcol_main:
        wf = next((w for w in _wfs if w["id"] == st.session_state.wf_sel), None)

        if st.session_state.wf_edit or wf is None:
            st.markdown("#### ⚙️ ワークフローの設定")
            _w = wf or {}
            wname = st.text_input("ワークフロー名", value=_w.get("name", ""), placeholder="例：記事の下書き→校正→要約")
            steps = list(_w.get("steps", []) or [])
            n = st.number_input("ステップ数", min_value=1, max_value=6, value=max(1, len(steps)))
            new_steps = []
            for i in range(int(n)):
                s = steps[i] if i < len(steps) else {}
                st.markdown(f"**ステップ {i + 1}**")
                sc1, sc2 = st.columns([1, 2])
                _idx = _ai_opts.index(s.get("ai")) if s.get("ai") in _ai_opts else 0
                ai_name = sc1.selectbox("担当AI", _ai_opts, index=_idx, key=f"wfai_{i}")
                instr = sc2.text_input("指示", value=s.get("instruction", ""), key=f"wfin_{i}",
                                       placeholder="このステップで行うこと（前段の出力が【入力】として渡る）")
                new_steps.append({"ai": ai_name, "instruction": instr})
            wb1, wb2 = st.columns(2)
            if wb1.button("💾 保存", type="primary", use_container_width=True, key="wf_save"):
                if not wname.strip():
                    st.error("名前を入力してください。")
                else:
                    if wf:
                        wf.update({"name": wname, "steps": new_steps})
                    else:
                        nid = uuid.uuid4().hex[:8]
                        _wfs.append({"id": nid, "name": wname, "steps": new_steps})
                        st.session_state.wf_sel = nid
                    if _save_wfs(_wfs):
                        st.session_state.wf_edit = False
                        st.success("保存しました。")
                        st.rerun()
                    else:
                        st.error("保存に失敗しました（DB接続を確認）。")
            if wf and wb2.button("🗑️ 削除", use_container_width=True, key="wf_del"):
                _wfs = [w for w in _wfs if w["id"] != wf["id"]]
                _save_wfs(_wfs)
                st.session_state.wf_sel = (_wfs[0]["id"] if _wfs else None)
                st.session_state.wf_edit = False
                st.rerun()

        elif wf:
            h1, h2 = st.columns([7, 3])
            h1.markdown(f"#### 🔧 {wf.get('name')}")
            if h2.button("⚙️ 編集", use_container_width=True, key="wf_editbtn"):
                st.session_state.wf_edit = True
                st.rerun()
            st.caption(" → ".join(f"{s.get('ai')}：{(s.get('instruction') or '')[:18]}" for s in wf.get("steps", [])) or "(ステップ未設定)")
            wf_input = st.text_area("入力", placeholder="このワークフローへの最初の入力（任意）", height=90)
            if st.button("⚡ ワークフローを実行", type="primary", use_container_width=True, key="wf_run"):
                cur = wf_input or ""
                for i, s in enumerate(wf.get("steps", [])):
                    ai = _ai_by_name(s.get("ai"))
                    prompt = (s.get("instruction", "") + (("\n\n【入力】\n" + cur) if cur else "")).strip()
                    with st.spinner(f"ステップ {i + 1} を実行中..."):
                        try:
                            if ai:
                                out = agent.direct_chat(
                                    [{"role": "system", "content": _sysmsg(ai)}, {"role": "user", "content": prompt}],
                                    provider=ai.get("provider"), api_key=(ai.get("api_key") or None), model=(ai.get("model") or None))
                            else:
                                out = get_ai_response(prompt)
                        except Exception as e:
                            out = f"⚠️ ステップ{i + 1}でエラー: {e}"
                    with st.expander(f"ステップ {i + 1}：{s.get('ai')} — {(s.get('instruction') or '')[:30]}",
                                     expanded=(i == len(wf.get('steps', [])) - 1)):
                        st.markdown(out)
                    cur = out
                st.success("✅ ワークフロー完了（最後のステップが最終出力）。")
        else:
            st.info("左の『➕ 新規ワークフロー』から、複数AIの連鎖を組み立てましょう。")
