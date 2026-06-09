import streamlit as st
import os
import hashlib
import smtplib
from email.mime.text import MIMEText
import random

st.markdown("""
    <style>
    .cyber-title { color: #2b6cb0; font-weight: 800; letter-spacing: 2px; margin-bottom: 20px; text-shadow: 2px 2px 4px rgba(255,255,255,0.8); }
    .setting-menu label { cursor: pointer !important; }
    [data-testid="stVerticalBlockBorderWrapper"] {
        background: rgba(255, 255, 255, 0.4) !important;
        backdrop-filter: blur(10px) !important;
        border: 1px solid rgba(255, 255, 255, 0.9) !important;
        border-radius: 15px !important;
        box-shadow: 6px 6px 15px #000000, -4px -4px 12px #15151c !important;
    }
    </style>
""", unsafe_allow_html=True)

st.markdown("<h2 class='cyber-title'>⚙️ SYSTEM SETTINGS</h2>", unsafe_allow_html=True)

# 画面を左（メニュー）と右（コンテンツ）に分割
col_menu, col_content = st.columns([2, 8], gap="large")

with col_menu:
    st.markdown("<div style='font-weight:bold; color:#718096; margin-bottom:10px;'>[ MENU ]</div>", unsafe_allow_html=True)
    setting_mode = st.radio("設定メニュー", [
        "🛠️ 基本設定",
        "🧠 コア設定",
        "🕰️ システム復元", 
        "🔐 Secure Vault",
        "💰 副業自動化",
        "📖 取扱説明書",
        "🚪 ログアウト"
    ], label_visibility="collapsed")

with col_content:
    # ================================
    if setting_mode == "🛠️ 基本設定":
        st.markdown("#### 🛠️ 基本設定 (General)")
        st.info("言語設定の切り替えや、メイン画面の背景変更、ログイン画面のパスワード変更機能をここに追加します（今後実装予定）。")

    # ================================
    elif setting_mode == "🧠 コア設定":
        st.markdown("#### 🧠 コア設定 (Core)")
        st.info("コアの脈動、色、音声フィルターなどの設定パネルにアクセスする機能をここに追加します。")

    # ================================
    elif setting_mode == "🕰️ システム復元":
        st.markdown("#### 🕰️ SYSTEM TIME MACHINE (過去5回分)")
        st.caption("/// 進化（OVERRIDE）前の安全な状態に復元します ///")
        
        os.makedirs("backups", exist_ok=True)
        backup_files = sorted([f for f in os.listdir("backups") if f.endswith(".py")], reverse=True)
        
        if not backup_files:
            st.info("現在、バックアップ履歴はありません。「EVOLUTION」で進化を実行すると自動的に保存されます。")
        else:
            selected_backup = st.selectbox("復元するバージョンを選択:", backup_files)
            with st.expander(f"👁️ プレビュー : {selected_backup}", expanded=False):
                try:
                    with open(f"backups/{selected_backup}", "r", encoding="utf-8") as f:
                        backup_code = f.read()
                    st.code(backup_code, language="python")
                except Exception as e:
                    st.error(f"読み込みエラー: {e}")
            
            st.warning("⚠️ 復元を実行すると、現在の `core.py` はこのバックアップの状態で上書きされます。")
            if st.button("⏪ この時代に復元する", use_container_width=True, type="primary"):
                try:
                    with open("core.py", "w", encoding="utf-8") as f:
                        f.write(backup_code)
                    st.success("✅ SYSTEM RESTORED. 再起動しています...")
                    st.rerun()
                except Exception as e:
                    st.error(f"復元エラー: {e}")

    # ================================
    elif setting_mode == "🔐 Secure Vault":
        st.markdown("#### 🔐 SECURE VAULT (Cloud Sync)")
        st.caption("AI相棒や各種システムを動かすための「鍵」と「連絡網」を保管する極秘エリアです。データはクラウドに暗号化保存されます。")

        if 'DB_CONNECTED' not in globals() or not DB_CONNECTED:
             st.warning("データベース接続が確認できません。開発用のローカル金庫を使用します。")
             def load_vault(): return st.session_state.get('local_vault', {})
             def save_vault(data): st.session_state.local_vault = data; return True

        def hash_password(password):
            return hashlib.sha256(password.encode()).hexdigest()

        if "vault_unlocked" not in st.session_state:
            st.session_state.vault_unlocked = False
        if "reset_mode" not in st.session_state:
            st.session_state.reset_mode = False
        if "sent_otp" not in st.session_state:
            st.session_state.sent_otp = None

        # クラウドからロード
        vault_data = load_vault()

        # 🚪 ステージ1：認証（ロック画面 ＆ パスワードリセット）
        if not st.session_state.vault_unlocked:
            col1, col2, col3 = st.columns([1, 8, 1])
            with col2:
                with st.container(border=True):
                    st.markdown("<h3 style='text-align:center;'>🔑 SYSTEM LOCKED</h3>", unsafe_allow_html=True)
                    
                    if "master_password_hash" not in vault_data:
                        st.info("👋 初回セットアップ：あなた専用の「マスターパスワード」を作成してください。")
                        new_pass = st.text_input("新しいマスターパスワード", type="password", key="new_pass")
                        new_pass_confirm = st.text_input("確認のためもう一度入力", type="password", key="new_pass_confirm")
                        
                        if st.button("金庫を初期化する ⚡", use_container_width=True):
                            if new_pass and new_pass == new_pass_confirm:
                                vault_data["master_password_hash"] = hash_password(new_pass)
                                vault_data["api_keys"] = {
                                    "gemini": "", "anthropic": "", "grok": "", "openai": "",
                                    "DIFY_API_KEY": "", "google_calendar": "", "slack": "", "line": "",
                                    "discord_webhook": "", "line_webhook": "",
                                    "my_email": "", "my_email_app_password": "",
                                    "gh_token": "", "gh_owner": "", "gh_repo": "",
                                    "youtube_client_id": "", "youtube_client_secret": "", "youtube_refresh_token": "",
                                    "shutterstock_ftp_host": "", "shutterstock_ftp_user": "", "shutterstock_ftp_pass": ""
                                }
                                
                                # 🚨 修正：保存に成功した時だけロック解除＆リロードする
                                if save_vault(vault_data):
                                    st.session_state.vault_unlocked = True
                                    st.success("金庫の初期化に成功しました！まずは内部で各種設定を行ってください。")
                                    st.rerun()
                                else:
                                    st.error("❌ クラウドへの初期化データの保存に失敗しました。上の赤いエラーを確認してください。")
                            else:
                                st.error("パスワードが一致しないか、入力されていません。")
                    
                    elif st.session_state.reset_mode:
                        st.warning("⚠️ パスワード復旧プロセスを開始します。")
                        my_email = vault_data.get("api_keys", {}).get("my_email", "")
                        my_email_pass = vault_data.get("api_keys", {}).get("my_email_app_password", "")
                        
                        if not my_email or not my_email_pass:
                            st.error("❌ 金庫内にGmailの連携設定がないため、復旧メールを送信できません。")
                            if st.button("⬅️ ロック画面に戻る"):
                                st.session_state.reset_mode = False
                                st.rerun()
                        else:
                            if st.session_state.sent_otp is None:
                                st.info(f"登録されているアドレス ({my_email}) 宛に、6桁の認証コードを送信します。")
                                if st.button("📩 認証コードを送信する", use_container_width=True):
                                    otp = str(random.randint(100000, 999999))
                                    try:
                                        msg = MIMEText(f"ボス、パスワードリセットの要請を受信しました。\n\n認証コード: 【 {otp} 】\n\nこのコードをアプリに入力して、新しいパスワードを設定してください。")
                                        msg["Subject"] = "【THE FORGE】パスワードリセット認証コード"
                                        msg["From"] = my_email
                                        msg["To"] = my_email
                                        
                                        server = smtplib.SMTP("smtp.gmail.com", 587)
                                        server.starttls()
                                        server.login(my_email, my_email_pass)
                                        server.send_message(msg)
                                        server.quit()
                                        
                                        st.session_state.sent_otp = otp
                                        st.success("認証コードを送信しました！メールをご確認ください。")
                                        st.rerun()
                                    except Exception as e:
                                        st.error(f"メール送信に失敗しました: {e}")
                            else:
                                st.info("メールに届いた6桁の認証コードと、新しいパスワードを入力してください。")
                                entered_otp = st.text_input("認証コード (6桁)")
                                reset_new_pass = st.text_input("新しいパスワード", type="password")
                                reset_confirm_pass = st.text_input("新しいパスワード(確認)", type="password")
                                
                                if st.button("🔐 パスワードを再設定する", use_container_width=True):
                                    if entered_otp == st.session_state.sent_otp:
                                        if reset_new_pass and reset_new_pass == reset_confirm_pass:
                                            vault_data["master_password_hash"] = hash_password(reset_new_pass)
                                            save_vault(vault_data)
                                            st.session_state.reset_mode = False
                                            st.session_state.sent_otp = None
                                            st.success("パスワードの再設定が完了しました！新しいパスワードでログインしてください。")
                                            st.rerun()
                                        else:
                                            st.error("新しいパスワードが一致しません。")
                                    else:
                                        st.error("認証コードが間違っています。")
                                
                                if st.button("キャンセル"):
                                    st.session_state.reset_mode = False
                                    st.session_state.sent_otp = None
                                    st.rerun()

                    else:
                        st.warning("⚠️ このエリアはボス（管理者）の承認が必要です。")
                        enter_pass = st.text_input("マスターパスワードを入力", type="password", key="enter_pass")
                        
                        if st.button("UNLOCK 🔓", use_container_width=True):
                            if hash_password(enter_pass) == vault_data["master_password_hash"]:
                                st.session_state.vault_unlocked = True
                                st.success("認証完了。金庫を開きます。")
                                st.rerun()
                            else:
                                st.error("アクセス拒否：パスワードが違います。")
                        
                        st.markdown("---")
                        if st.button("パスワードを忘れた場合 (メールで復旧)", use_container_width=True):
                            st.session_state.reset_mode = True
                            st.rerun()

        # 🔓 ステージ2：金庫の内部
        if st.session_state.vault_unlocked:
            if st.button("🔒 金庫をロックして退出"):
                st.session_state.vault_unlocked = False
                st.rerun()

            st.markdown("#### ⚙️ CORE API & COMMUNICATION CONFIGURATION")
            st.info("ここに入力されたキーはシステム全体で安全に共有され、クラウドに暗号化保存されます。")
            
            with st.form("vault_keys_form"):
                keys = vault_data.get("api_keys", {})
                
                st.markdown("##### 📧 Email System (パスワード復旧・通知用)")
                new_email = st.text_input("自分のGmailアドレス", value=keys.get("my_email", ""))
                new_email_pass = st.text_input("Gmail アプリパスワード (16桁)", value=keys.get("my_email_app_password", ""), type="password")
                with st.expander("ℹ️ Gmailアプリパスワードの取得手順（超詳細）"):
                    st.markdown("""
                    1. [Googleアカウント管理画面](https://myaccount.google.com/) にアクセスしてログインします。
                    2. 左側のメニューから **「セキュリティ」** をクリックします。
                    3. 少し下にスクロールし、「Google へのログイン」の中にある **「2段階認証プロセス」** をクリックしてオンにします（既にオンなら次へ）。
                    4. 画面上部の検索窓（虫眼鏡マーク）で **「アプリパスワード」** と入力して検索・選択します。
                    5. アプリ名に「THE FORGE」など好きな名前を入力して **「作成」** ボタンを押します。
                    6. 画面に黄色の背景で表示される **16桁の英字（空白なしでそのまま）** をコピーして、上のパスワード欄に貼り付けてください。
                    """)
                
                # 🌟🌟🌟 新規追加：Dify API Key の入力欄 🌟🌟🌟
                st.markdown("##### 🧠 Dify AI Core (THE FORGE OS Brain)")
                new_dify_key = st.text_input("Dify API Key (app-...)", value=keys.get("DIFY_API_KEY", ""), type="password")
                with st.expander("ℹ️ Dify API Keyの取得手順"):
                    st.markdown("""
                    1. [Dify Cloud](https://dify.ai/) のStudioにアクセスし、「AIBOU_Core」のChatflowを開きます。
                    2. 画面のメニューから **「APIアクセス（API Access）」** をクリックします。
                    3. 右上の「APIキー（API Keys）」から **「新しいシークレットキーを作成」** を押します。
                    4. 生成された **`app-`** から始まる文字列をコピーして、上の欄に貼り付けてください。
                    """)

                st.markdown("##### 🧠 AI Core (Gemini)")
                new_gemini = st.text_input("Gemini API Key", value=keys.get("gemini", ""), type="password")
                with st.expander("ℹ️ Gemini API Keyの取得手順（完全無料）"):
                    st.markdown("""
                    1. [Google AI Studio](https://aistudio.google.com/) にアクセスし、普段使っているGoogleアカウントでログインします。
                    2. 規約の同意画面が出たらチェックを入れて進みます。
                    3. 画面左上のメニュー（または左側ナビゲーション）にある **「Get API key」** という青い鍵マークのボタンをクリックします。
                    4. **「Create API key」** ボタンをクリックします。
                    5. 「Create API key in new project」を選択するとキーが生成されます。
                    6. 生成された **`AIza...`** から始まる非常に長い文字列をコピーして、上の欄に貼り付けてください。
                    """)

                st.markdown("##### 🤖 Multi-AI（任意・どれか1つでもOK）")
                st.caption("複数入れた場合の優先順位：Gemini → Claude → Grok → OpenAI。空欄でも構いません。")
                new_anthropic = st.text_input("Anthropic (Claude) API Key", value=keys.get("anthropic", ""), type="password", placeholder="sk-ant-...")
                new_grok = st.text_input("Grok (xAI) API Key", value=keys.get("grok", ""), type="password", placeholder="xai-...")
                new_openai = st.text_input("OpenAI API Key", value=keys.get("openai", ""), type="password", placeholder="sk-...")
                with st.expander("ℹ️ 各AI APIキーの取得先"):
                    st.markdown("""
                    - **Claude (Anthropic)**: [console.anthropic.com](https://console.anthropic.com/) ＞ 「API Keys」＞「Create Key」（**`sk-ant-`** で始まる）
                    - **Grok (xAI)**: [console.x.ai](https://console.x.ai/) ＞ 「API Keys」（**`xai-`** で始まる。AIエージェントの**Web検索ツール**にも使われます）
                    - **OpenAI**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys) ＞ 「Create new secret key」（**`sk-`** で始まる）
                    """)
                
                st.markdown("##### 📅 Schedule (Google Calendar)")
                new_calendar = st.text_input("Google Calendar JSON (サービスアカウント)", value=keys.get("google_calendar", ""), type="password")
                with st.expander("ℹ️ Google Calendar 連携の準備について（上級者向け）"):
                    st.markdown("""
                    *※カレンダーへの書き込みにはGoogle Cloudの「サービスアカウント」が必要です。*
                    1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスしてログインします。
                    2. 左上の「プロジェクトの選択」から **「新しいプロジェクト」** を作成します。
                    3. 左メニュー「APIとサービス」＞「ライブラリ」へ進み、検索窓で **「Google Calendar API」** を検索して **「有効にする」** を押します。
                    4. 次に「APIとサービス」＞「認証情報」へ進み、画面上の「＋認証情報を作成」から **「サービスアカウント」** を選びます。
                    5. アカウント名（例: ai-calendar）を入力して「完了」まで進みます。
                    6. 作成されたサービスアカウント（xxxx@yyy.iam.gserviceaccount.com）をクリックし、「キー」タブを開きます。
                    7. 「鍵を追加」＞「新しい鍵を作成」＞ **「JSON」** を選んで作成すると、ファイルがダウンロードされます。
                    8. メモ帳などでダウンロードしたJSONファイルを開き、**中身のテキストをすべて**コピーして上の欄に貼り付けます。
                    9. **【最重要】** 普段使っているGoogleカレンダーを開き、右上の歯車＞設定＞特定のカレンダーの設定＞「特定のユーザーとの共有」に、**先ほどのサービスアカウントのメールアドレス**を追加し、権限を **「予定の変更権限」** に設定してください。
                    """)
                
                st.markdown("##### 💬 Communication (Slack & LINE)")
                new_slack = st.text_input("Slack Bot Token", value=keys.get("slack", ""), type="password")
                with st.expander("ℹ️ Slack Bot Tokenの取得手順"):
                    st.markdown("""
                    1. [Slack API (Your Apps)](https://api.slack.com/apps) にアクセスし、**「Create New App」** ＞ 「From scratch」を選択します。
                    2. アプリ名（例: THE FORGE）を入力し、導入したい自分のワークスペースを選択して「Create App」を押します。
                    3. 左メニューの **「OAuth & Permissions」** をクリックして少し下にスクロールします。
                    4. 「Scopes」セクションの「Bot Token Scopes」で **「Add an OAuth Scope」** を押し、**`chat:write`** を追加します。
                    5. 画面一番上に戻り、**「Install to Workspace」** ボタンを押して許可（Allow）します。
                    6. 画面に表示される **`xoxb-`** から始まる「Bot User OAuth Token」をコピーして、上の欄に貼り付けます。
                    """)

                new_line = st.text_input("LINE Messaging API Token", value=keys.get("line", ""), type="password")
                with st.expander("ℹ️ LINE Tokenの取得手順"):
                    st.markdown("""
                    1. [LINE Developers](https://developers.line.biz/ja/) にアクセスし、自分のLINEアカウントでログインします。
                    2. 「コンソール」を開き、新しく「プロバイダー」を作成します（名前は自分の名前などでOK）。
                    3. 作成したプロバイダーを開き、**「Messaging API」** チャネルを新規作成します。
                    4. 必須項目（アプリ名、説明など）を適当に入力して作成を完了させます。
                    5. 作成したチャネルを開き、**「Messaging API設定」** タブをクリックします。
                    6. 一番下までスクロールし、「チャネルアクセストークン」の **「発行」** ボタンを押します。
                    7. 表示された非常に長い文字列をコピーして、上の欄に貼り付けてください。
                    """)

                st.markdown("##### 🔔 Webhook 通知（AIエージェントの send_notification 用）")
                new_discord_webhook = st.text_input("Discord Webhook URL", value=keys.get("discord_webhook", ""), type="password", placeholder="https://discord.com/api/webhooks/...")
                new_line_webhook = st.text_input("LINE Webhook URL（任意）", value=keys.get("line_webhook", ""), type="password")
                with st.expander("ℹ️ Discord Webhookの作り方（最も簡単）"):
                    st.markdown("""
                    1. Discordの対象サーバーで、通知を受け取りたいチャンネルの **「⚙️ 編集」** を開きます。
                    2. **「連携サービス（Integrations）」** ＞ **「ウェブフック（Webhooks）」** を開きます。
                    3. **「新しいウェブフック」** を押し、表示された **「ウェブフックURLをコピー」** を押します。
                    4. コピーしたURL（`https://discord.com/api/webhooks/...`）を上の欄に貼り付けてください。
                    5. これでAIが「〇〇をDiscordに通知して」の指示で（承認後に）メッセージを送れるようになります。
                    """)

                st.markdown("##### 📺 配信（YouTube / Shutterstock）— 副業自動化")
                st.caption("設定すると、承認済みアセットを GitHub Actions の配信ワークフローが各公式手段で投稿します（未設定の配信先はスキップ）。")
                new_yt_id = st.text_input("YouTube OAuth Client ID", value=keys.get("youtube_client_id", ""), type="password")
                new_yt_secret = st.text_input("YouTube OAuth Client Secret", value=keys.get("youtube_client_secret", ""), type="password")
                new_yt_refresh = st.text_input("YouTube Refresh Token", value=keys.get("youtube_refresh_token", ""), type="password")
                with st.expander("ℹ️ YouTube連携の手順（Refresh Token の取り方）"):
                    st.markdown("""
                    1. [Google Cloud Console](https://console.cloud.google.com/) で **「YouTube Data API v3」** を有効化します。
                    2. 「認証情報」＞「OAuthクライアントID」を **種類: デスクトップ アプリ** で作成し、Client ID / Secret を取得します。
                    3. それらを上の2欄に入力（またはお手元PCの環境変数 `YT_CLIENT_ID`/`YT_CLIENT_SECRET` に設定）します。
                    4. お手元のPCで **`python youtube_oauth_helper.py`** を実行 → ブラウザで承認 → 表示された **refresh token** を上の欄へ貼り付けます。
                    5. 保存すると、動画は最初 **非公開(private)** で投稿されます（内容を確認してから公開）。
                    """)
                new_ss_host = st.text_input("Shutterstock FTP Host", value=keys.get("shutterstock_ftp_host", ""), placeholder="例: ftps.shutterstock.com")
                new_ss_user = st.text_input("Shutterstock FTP User", value=keys.get("shutterstock_ftp_user", ""))
                new_ss_pass = st.text_input("Shutterstock FTP Password", value=keys.get("shutterstock_ftp_pass", ""), type="password")
                with st.expander("ℹ️ Shutterstock連携の手順（公式FTPS）"):
                    st.markdown("""
                    1. Shutterstock コントリビューターのアカウントを用意します。
                    2. コントリビューター管理画面のアップロード/FTP設定で、FTPの **ホスト / ユーザー / パスワード** を確認します。
                    3. それらを上の3欄に入力して保存します。アップロード後、メタデータ（タイトル/タグ）は管理画面で紐付けます。
                    """)

                st.markdown("##### 🚀 Cloud Deploy (GitHub)")
                new_gh_token = st.text_input("GitHub Personal Access Token", value=keys.get("gh_token", ""), type="password")
                new_gh_owner = st.text_input("GitHub Username", value=keys.get("gh_owner", ""), placeholder="例: YamadaTaro")
                new_gh_repo = st.text_input("Repository Name", value=keys.get("gh_repo", ""), placeholder="例: aibou_app")
                with st.expander("ℹ️ GitHubトークンの取得・設定手順（自動デプロイ用）"):
                    st.markdown("""
                    1. [GitHubのトークン設定画面](https://github.com/settings/tokens) にアクセスしてログインします。
                    2. 画面右上の **「Generate new token」** を押し、**「Generate new token (classic)」** を選びます。
                    3. 「Note（名前）」に「THE FORGE OS Deploy」など分かりやすい名前を入力します。
                    4. 「Expiration（期限）」は **「No expiration（無期限）」** を選ぶと、後で更新する手間が省けます（セキュリティ警告が出ますがそのまま進んでOKです）。
                    5. 「Select scopes（権限）」の一覧から、一番上にある **「repo」**（リポジトリの全権限）のチェックボックスにチェックを入れます。
                    6. 画面一番下緑色の **「Generate token」** を押します。
                    7. **`ghp_`** から始まるトークンが表示されるので、それをコピーして一番上の欄（Token）に貼り付けてください。
                    8. 「GitHub Username」にはボスのユーザー名（例: minami-taro）を入力します。
                    9. 「Repository Name」には、Streamlit Cloudと連携しているこのアプリのリポジトリ名（例: aibouai_app）を入力してください。
                    """)
                
                st.markdown("---")
                submitted = st.form_submit_button("💾 クラウドに暗号化して保存", type="primary", use_container_width=True)
                
                if submitted:
                    vault_data["api_keys"] = {
                        "my_email": new_email, "my_email_app_password": new_email_pass,
                        "DIFY_API_KEY": new_dify_key, # 🌟 ここでDifyのキーを保存
                        "gemini": new_gemini, "anthropic": new_anthropic, "grok": new_grok, "openai": new_openai,
                        "google_calendar": new_calendar,
                        "slack": new_slack, "line": new_line,
                        "discord_webhook": new_discord_webhook, "line_webhook": new_line_webhook,
                        "gh_token": new_gh_token, "gh_owner": new_gh_owner, "gh_repo": new_gh_repo,
                        "youtube_client_id": new_yt_id, "youtube_client_secret": new_yt_secret,
                        "youtube_refresh_token": new_yt_refresh,
                        "shutterstock_ftp_host": new_ss_host, "shutterstock_ftp_user": new_ss_user,
                        "shutterstock_ftp_pass": new_ss_pass,
                    }
                    
                    if save_vault(vault_data):
                        st.session_state.global_api_keys = vault_data["api_keys"]
                        st.success("✅ 設定を安全に保存し、クラウドデータベースへ同期しました！")
                        st.balloons()
                    else:
                        st.error("❌ 保存に失敗しました。データベースの接続設定を確認してください。")

            # ─────────────────────────────────────────────
            # 🔑 用途別 APIキー（マルチアカウント）
            # 各処理(用途)に、別アカウントで発行したキーを割り当てる。未設定なら共通キーへ。
            # 既存の api_keys フォームとは別フィールド(key_slots)に保存するので互いに上書きしない。
            st.markdown("---")
            st.markdown("#### 🔑 用途別 APIキー（マルチアカウント）")
            st.caption("各処理(用途)ごとに、別のGoogleアカウント等で発行したキーを割り当てられます。未設定の用途は上の共通キーを使います。")
            try:
                import key_manager
                _slots = vault_data.get("key_slots", {})
                with st.form("key_slots_form"):
                    _new_slots = {}
                    for _p in key_manager.PURPOSES:
                        _cur = _slots.get(_p["id"], {})
                        _default_prov = _cur.get("provider", _p["provider"])
                        _c1, _c2 = st.columns([1, 3])
                        _prov = _c1.selectbox(
                            "Provider", key_manager.PROVIDERS,
                            index=key_manager.PROVIDERS.index(_default_prov) if _default_prov in key_manager.PROVIDERS else 0,
                            key=f"slotprov_{_p['id']}",
                        )
                        _val = _c2.text_input(
                            f"{_p['label']}（{_p['id']}）", value=_cur.get("key", ""),
                            type="password", key=f"slotkey_{_p['id']}",
                            placeholder="未設定なら共通キーを使用",
                        )
                        if _val.strip():
                            _new_slots[_p["id"]] = {"provider": _prov, "key": _val.strip()}
                    st.caption("※ 各キーは各プロバイダの利用規約の範囲内で使用してください。")
                    if st.form_submit_button("💾 用途別キーを保存", use_container_width=True):
                        vault_data["key_slots"] = _new_slots
                        if save_vault(vault_data):
                            st.session_state.key_slots = _new_slots
                            st.success("✅ 用途別キーを保存しました。")
                        else:
                            st.error("❌ 保存に失敗しました。")
                with st.expander("ℹ️ headless（GitHub Actions）側の用途別キーについて"):
                    st.markdown(
                        "GitHub Actions では環境変数で用途別キーを渡せます（未設定なら共通キーにフォールバック）：\n"
                        "- 夜間生成: `GEMINI_API_KEY_NIGHTLY`（なければ `GEMINI_API_KEY`）\n"
                        "- 共通: `GEMINI_API_KEY`\n\n"
                        "命名規則は `<プロバイダのキー名>_<用途ID大文字>`（例: `GEMINI_API_KEY_INCOME_GEN`）。"
                    )
            except Exception as _e:
                st.warning(f"用途別キーUIを表示できませんでした: {_e}")

    # ================================
    elif setting_mode == "💰 副業自動化":
        st.markdown("#### 💰 副業自動化 セットアップ")
        st.caption("設定状況の確認と接続テスト。鍵は基本『🔐 Secure Vault』に保存し、Actionsはそこから自動取得します。")

        keys = st.session_state.get("global_api_keys", {}) or {}
        slots = st.session_state.get("key_slots", {}) or {}
        def _has(*names): return any(keys.get(n) for n in names)
        def _mark(b): return "✅" if b else "⬜"

        db_ok = bool(globals().get("DB_CONNECTED"))
        table_ok = False
        if db_ok:
            try:
                globals().get("supabase").table("income_jobs").select("id").limit(1).execute()
                table_ok = True
            except Exception:
                table_ok = False

        st.markdown("##### ✅ チェックリスト")
        st.write(f"{_mark(db_ok)} Supabase 接続（SUPABASE_URL / KEY）")
        st.write(f"{_mark(table_ok)} テーブル `income_jobs` / `income_stats`（`supabase_schema.sql` を実行）")
        st.write(f"{_mark(bool(keys.get('gemini')))} Gemini APIキー（共通）")
        st.write(f"{_mark(bool((slots.get('nightly') or {}).get('key')))} 夜間生成キー（任意・用途別 `nightly`）")
        st.write(f"{_mark(bool((slots.get('asset_image') or {}).get('key')))} 画像生成キー（任意・用途別 `asset_image`）")
        st.write(f"{_mark(_has('discord_webhook'))} Discord 通知（任意）")
        st.write(f"{_mark(_has('youtube_client_id') and _has('youtube_refresh_token'))} YouTube 配信（任意）")
        st.write(f"{_mark(_has('shutterstock_ftp_host'))} Shutterstock 配信（任意）")

        st.markdown("##### 🔌 接続テスト")
        t1, t2 = st.columns(2)
        if t1.button("🧠 Gemini をテスト", use_container_width=True):
            with st.spinner("呼び出し中..."):
                r = get_ai_response("Reply with just: OK")
            (st.success if not str(r).startswith("⚠️") else st.error)(f"応答: {str(r)[:100]}")
        if t2.button("🔔 Discord に通知テスト", use_container_width=True):
            url = keys.get("discord_webhook", "")
            if not url:
                st.warning("Discord Webhook が未設定です。")
            else:
                try:
                    requests.post(url, json={"content": "✅ THE FORGE 接続テスト"}, timeout=20)
                    st.success("送信しました。Discordをご確認ください。")
                except Exception as e:
                    st.error(f"失敗: {e}")
        t3, t4 = st.columns(2)
        if t3.button("🗄 Supabase をテスト", use_container_width=True):
            if not db_ok:
                st.error("DB未接続です（SUPABASE_URL / KEY を確認）。")
            else:
                try:
                    n = len(globals().get("supabase").table("income_jobs").select("id").limit(5).execute().data or [])
                    st.success(f"OK：income_jobs に到達（{n}件）。")
                except Exception as e:
                    st.error(f"失敗（テーブル未作成かも）: {e}")
        if t4.button("📷 Shutterstock FTP をテスト", use_container_width=True):
            host, user, pw = keys.get("shutterstock_ftp_host", ""), keys.get("shutterstock_ftp_user", ""), keys.get("shutterstock_ftp_pass", "")
            if not (host and user and pw):
                st.warning("Shutterstock FTP 情報が未設定です。")
            else:
                try:
                    from ftplib import FTP_TLS
                    f = FTP_TLS(host); f.login(user, pw); f.prot_p(); f.quit()
                    st.success("ログイン成功。")
                except Exception as e:
                    st.error(f"失敗: {e}")
        if st.button("📺 YouTube 認証をテスト", use_container_width=True):
            cid, csec, rtok = keys.get("youtube_client_id", ""), keys.get("youtube_client_secret", ""), keys.get("youtube_refresh_token", "")
            if not (cid and csec and rtok):
                st.warning("YouTube OAuth 情報が未設定です。")
            else:
                try:
                    from google.oauth2.credentials import Credentials
                    from googleapiclient.discovery import build as _gbuild
                    creds = Credentials(token=None, refresh_token=rtok, client_id=cid, client_secret=csec,
                                        token_uri="https://oauth2.googleapis.com/token",
                                        scopes=["https://www.googleapis.com/auth/youtube.readonly"])
                    yt = _gbuild("youtube", "v3", credentials=creds)
                    ch = yt.channels().list(part="snippet", mine=True).execute()
                    title = (ch.get("items") or [{}])[0].get("snippet", {}).get("title", "(不明)")
                    st.success(f"認証OK：チャンネル「{title}」")
                except Exception as e:
                    st.error(f"失敗: {e}")

        st.markdown("##### 🤖 GitHub Actions（自動運転）")
        st.markdown(
            "1. リポジトリの **Settings → Secrets and variables → Actions** に "
            "`SUPABASE_URL` / `SUPABASE_KEY` / `MASTER_ENCRYPTION_KEY` を登録（他の鍵はこのVaultから自動取得）。\n"
            "2. **Nightly Asset Generation**：毎日テーマ生成→Inboxに `pending` 追加（配信なし・安全）。\n"
            "3. ここ Mission Control で承認 → `approved`。\n"
            "4. **Publish Approved Assets** を手動実行 → 画像/動画を生成し、設定済みの配信先へ投稿。"
        )
        with st.expander("ℹ️ YouTube refresh token の取り方"):
            st.markdown("お手元のPCで `python youtube_oauth_helper.py` を実行し、表示された値を "
                        "Secure Vault の「YouTube Refresh Token」に保存してください。")

    # ================================
    elif setting_mode == "📖 取扱説明書":
        st.markdown("#### 📖 MANUAL")
        st.info("システムの使い方は今後ここに詳しく記載します。各種APIの取得方法は以下を開いてください。")
        with st.expander("ℹ️ Gmailアプリパスワードの取得手順"):
            st.markdown("1. [Googleアカウント管理画面](https://myaccount.google.com/) にアクセス。\n2. 「セキュリティ」>「2段階認証プロセス」をオン。\n3. 「アプリパスワード」を検索し作成。16桁の英字をコピー。")
        with st.expander("ℹ️ Dify API Keyの取得手順"):
            st.markdown("1. [Dify Cloud](https://dify.ai/) にアクセス。\n2. StudioからChatflowを開き、APIアクセス画面で「新しいシークレットキーを作成」。")
        with st.expander("ℹ️ Gemini API Keyの取得手順"):
            st.markdown("1. [Google AI Studio](https://aistudio.google.com/) にアクセス。\n2. 「Get API key」>「Create API key」をクリックして生成。")
        with st.expander("ℹ️ Google Calendar 連携の準備について"):
            st.markdown("1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成。\n2. 「Google Calendar API」を有効化し「サービスアカウント」を作成。\n3. JSONキーをダウンロードし中身をコピペ。")
        with st.expander("ℹ️ Slack Bot Token / LINE Tokenの取得手順"):
            st.markdown("Slack: [Slack API](https://api.slack.com/apps) でアプリを作成し「OAuth & Permissions」から `xoxb-` トークンを取得。\nLINE: [LINE Developers](https://developers.line.biz/ja/) でMessaging APIを作成し、一番下の「チャネルアクセストークン」を発行。")
        with st.expander("ℹ️ GitHubトークンの取得手順"):
            st.markdown("1. [GitHubのトークン設定画面](https://github.com/settings/tokens) にアクセス。\n2. 「Generate new token (classic)」を選ぶ。\n3. 「No expiration」にし「repo」にチェックを入れて生成。")

    # ================================
    elif setting_mode == "🚪 ログアウト":
        st.markdown("#### 🚪 LOGOUT")
        st.warning("システムをロックしてログイン画面に戻ります。")
        if st.button("LOGOUT 🔒", type="primary"):
            st.session_state.logged_in = False
            st.rerun()
