st.title("📋 現在のタスク")
room_help("Active Tasks")
raw_data = sheet.get_all_values() 

if len(raw_data) > 1:
    headers = ['タスクID', '目標', 'タスク内容', 'ステータス', 'ログ', 'ボスの回答']
    body = [row[:6] + [''] * (6 - len(row[:6])) for row in raw_data[1:]] 
    df = pd.DataFrame(body, columns=headers)
    
    st.markdown("### 📈 プロジェクト状況")
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("総タスク数", len(df))
    col2.metric("未着手 📝", len(df[df['ステータス'] == '未着手']))
    col3.metric("実行中 ⚙️", len(df[df['ステータス'] == '実行中']))
    col4.metric("確認待ち 🚨", len(df[df['ステータス'] == '確認待ち']))
    st.divider()

    waiting_tasks = df[df['ステータス'] == '確認待ち']
    if not waiting_tasks.empty:
        st.warning("🚨 AIがあなたの指示を待っています！")
        for index, row in waiting_tasks.iterrows():
            with st.expander(f"質問: {row['タスク内容']}", expanded=True):
                st.info(f"**AIからのメッセージ:**\n{row['ログ']}")
                with st.form(key=f"form_{index}"):
                    answer = st.text_input("ボスの回答:")
                    submit = st.form_submit_button("回答を送信してタスクを再開 🚀")
                    if submit and answer:
                        sheet_row = index + 2 
                        sheet.update_cell(sheet_row, 6, answer)
                        sheet.update_cell(sheet_row, 4, "未着手")
                        st.success("指示を送信しました！画面を更新します...")
                        st.rerun()
        st.divider()

    st.markdown("### 📋 進行中のタスク一覧")
    current_df = df[df['ステータス'] != '完了'] 
    
    def color_status(val):
        color = 'white'
        if val == '完了': color = '#c8e6c9'
        elif val == '実行中': color = '#bbdefb'
        elif val == '確認待ち': color = '#ffcdd2'
        return f'background-color: {color}'
    
    styled_df = current_df.style.map(color_status, subset=['ステータス'])
    st.dataframe(styled_df, use_container_width=True)
else:
    st.info("現在、登録されているタスクはありません。HUBのコアに作業を依頼すると、ここに実行中タスクとして表示されます。")