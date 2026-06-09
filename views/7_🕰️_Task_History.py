# 💎 アーカイブ専用の美しいCSS
st.markdown("""
    <style>
    .history-card {
        background: rgba(255, 255, 255, 0.04);
        backdrop-filter: blur(10px);
        border: 1px solid #20202a;
        border-radius: 15px;
        padding: 20px;
        margin-bottom: 20px;
        box-shadow: 6px 6px 15px #000000, -4px -4px 12px #15151c;
        transition: all 0.3s ease;
    }
    .history-card:hover {
        transform: translateY(-3px);
        border-color: #00e676;
        box-shadow: 0 8px 25px rgba(0, 230, 118, 0.3);
    }
    .badge-success {
        background-color: #00e676; color: white; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; letter-spacing: 1px;
    }
    .cyber-title { color: #2b6cb0; font-weight: 800; letter-spacing: 2px; margin-bottom: 5px; text-shadow: 2px 2px 4px rgba(255,255,255,0.8); }
    </style>
""", unsafe_allow_html=True)

st.markdown("<h2 class='cyber-title'>🕰️ TASK ARCHIVE</h2>", unsafe_allow_html=True)
st.caption("/// 完了済みのミッション・ログ・アーカイブ ///")
st.markdown("<br>", unsafe_allow_html=True)

try:
    raw_data = sheet.get_all_values() 
    if len(raw_data) > 1:
        headers = ['タスクID', '目標', 'タスク内容', 'ステータス', 'ログ', 'ボスの回答']
        body = [row[:6] + [''] * (6 - len(row[:6])) for row in raw_data[1:]] 
        df = pd.DataFrame(body, columns=headers)
        
        completed_df = df[df['ステータス'] == '完了']
        
        if not completed_df.empty:
            # 🔍 検索フィルターの実装
            col_search, col_count = st.columns([7, 3])
            with col_search:
                search_query = st.text_input("🔍 アーカイブを検索...", placeholder="タスク名やキーワードを入力", label_visibility="collapsed")
            
            # 検索キーワードで絞り込み
            if search_query:
                completed_df = completed_df[
                    completed_df['タスク内容'].str.contains(search_query, case=False, na=False) | 
                    completed_df['ログ'].str.contains(search_query, case=False, na=False)
                ]
            
            with col_count:
                st.markdown(f"<div style='text-align:right; font-weight:bold; color:#718096; padding-top:10px;'>Total Missions: {len(completed_df)}</div>", unsafe_allow_html=True)
            
            st.markdown("---")
            
            # 🗂️ 美しいカード形式で描画
            for index, row in completed_df.iterrows():
                st.markdown(f"""
                <div class="history-card">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <span style="font-weight: 800; color: #1a202c; font-size: 18px;">{row['タスク内容']}</span>
                        <span class="badge-success">ACCOMPLISHED</span>
                    </div>
                    <div style="font-size: 12px; color: #4a5568; margin-bottom: 15px; font-family: monospace;">
                        <b>ID:</b> {row['タスクID']} &nbsp;|&nbsp; <b>TARGET:</b> {row['目標']}
                    </div>
                    <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; border-left: 4px solid #3182ce; font-size: 13px; color: #2d3748;">
                        <b style="color:#2b6cb0;">🤖 SYSTEM LOG:</b><br>
                        {row['ログ']}
                    </div>
                </div>
                """, unsafe_allow_html=True)
        else:
            st.info("完了したタスクはまだありません。これから歴史を作っていきましょう！")
    else:
        st.info("現在、登録されているタスクはありません。")
except Exception as e:
    st.error(f"データベースの読み込みに失敗しました: {e}")