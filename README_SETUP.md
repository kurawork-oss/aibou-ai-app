# AIbou セットアップ & 引き継ぎガイド

AIbou（相棒AI）は、Streamlit ベースのパーソナル AI アシスタント OS です。
**完全無料**で構築・運用でき、AI の API キーは**利用者が自分で用意**します。

> Core Upgrade（自己書き換え）はオーナー専用機能です。配布版には含めないでください。

---

## 1. アーキテクチャ概要

```
app.py        # ランチャー。core.py を exec() で実行し、壊れたらセーフモード表示
core.py       # OS本体。認証・ルーティング・Google連携・get_ai_response/run_agent の公開
agent.py      # 🤖 Agent Engine（マルチAI切替 + ツール実行）★今回追加
views/        # 各画面（HUB / Forge Lab / Document Vault / ... ）
supabase_schema.sql  # Supabase テーブル定義
```

- `app.py` → `core.py` → 各 `views/*.py` を **すべて同じグローバル名前空間で exec()** します。
  そのため core.py で定義／import した名前（`get_ai_response`, `run_agent`,
  `execute_tool`, `sheet`, `get_calendar_service` 等）は全 view から直接使えます。
- `agent.py` は独立モジュールとして import され、core.py 側の道具（カレンダー／
  スプレッドシート／Supabase）は `agent.register_services(...)` で注入されます。

---

## 2. 必要な API / サービス

| サービス | 用途 | 必須? |
|---|---|---|
| Gemini API | AI 本体（無料枠あり・推奨） | どれか1つ |
| Anthropic (Claude) | AI 本体（任意） | 任意 |
| Grok (xAI) | AI 本体 + Web検索ツール | 任意 |
| OpenAI | AI 本体（任意） | 任意 |
| Supabase | API キーの暗号化保存 | 必須 |
| Google Sheets | タスク管理 | 任意 |
| Google Calendar | 予定の取得・登録 | 任意 |
| Discord / LINE Webhook | 通知送信 | 任意 |

AI キーは **Gemini → Claude → Grok → OpenAI** の優先順で自動選択されます
（複数入れた場合）。すべて Settings → 🔐 Secure Vault から登録します。

---

## 3. Supabase の準備（移行手順込み）

### 3-1. 新規プロジェクト作成
1. 新しい Google アカウントで [Supabase](https://supabase.com/) にログインし、新規プロジェクトを作成。
2. プロジェクトの **SQL Editor** を開き、リポジトリ同梱の [`supabase_schema.sql`](./supabase_schema.sql) を貼り付けて実行。
   - Phase 1 では `vault_data` テーブルだけあれば動きます。
3. **Project Settings → API** から以下を控える：
   - Project URL → `SUPABASE_URL`
   - `anon` / `service_role` キー → `SUPABASE_KEY`

### 3-2. Streamlit Secrets を更新
Streamlit Cloud の **Settings → Secrets**（またはローカルの `.streamlit/secrets.toml`）に
セクション 4 の内容を設定します。`MASTER_ENCRYPTION_KEY` は新しく生成してください：

```python
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

`core.py` の接続コードは **Secrets の値を変えるだけ**で新プロジェクトに切り替わります
（コード変更は不要です）。

### 3-3. ⚠️ 暗号鍵を変える場合の重要な注意（データ移行）
`vault_data.encrypted_keys` は `MASTER_ENCRYPTION_KEY` で暗号化されています。
**鍵を変えると、古いデータは復号できなくなります。** 移行の正しい手順は次の通り：

1. （旧環境が動くうちに）Settings → Secure Vault を開き、登録済みの API キーを控える。
2. 新しい Supabase プロジェクト + 新しい `MASTER_ENCRYPTION_KEY` に Secrets を切り替える。
3. アプリを再起動し、Secure Vault で**マスターパスワードを再設定**して各キーを入力 → 保存。
   - 保存時に新しい鍵で再暗号化され、新 `vault_data` に書き込まれます。

> つまり「鍵ごとの引っ越し」は **キーの再入力**で行います（暗号文のコピーはできません）。
> 同じ鍵のまま URL だけ変える場合は、旧 `vault_data` の行をそのままコピーすれば移行できます。

---

## 4. Streamlit Secrets（設定項目の完全版）

```toml
# .streamlit/secrets.toml （本番は Streamlit Cloud の Secrets 管理に入力）

# 認証
APP_PASSWORD = "your_password_here"

# Supabase（新しいプロジェクトのもの）
SUPABASE_URL = "https://xxxx.supabase.co"
SUPABASE_KEY = "eyJ..."
MASTER_ENCRYPTION_KEY = "32文字以上のランダム文字列"

# AI API（初期値。ユーザーは Settings 画面で上書き可能）
GEMINI_API_KEY = ""

# Google サービス
GOOGLE_CREDENTIALS = '''{"type": "service_account", ...}'''
GOOGLE_CALENDAR_ID = "primary"
GOOGLE_SHEET_NAME = "AibouAgent"
```

### ローカル開発（st.secrets が無い環境）
`st.secrets` が使えない場合、`core.py` の `get_secret()` が
**環境変数 → `.env` ファイル**の順にフォールバックします。リポジトリ直下に `.env` を置けます：

```
APP_PASSWORD=...
SUPABASE_URL=...
SUPABASE_KEY=...
MASTER_ENCRYPTION_KEY=...
GEMINI_API_KEY=...
```

`.env` と `.streamlit/secrets.toml` は `.gitignore` 済みです（コミットしないこと）。

---

## 5. ローカルでの起動

```bash
pip install -r requirements.txt
streamlit run app.py
```

---

## 6. AI エージェント（run_agent）の使い方

HUB のコンソールに自然文で指示すると、AI が必要に応じてツールを実行します。

- 「明日の10時にミーティングを追加して」→ カレンダー登録を**提案** → 承認ボタンで実行
- 「〇〇をDiscordに通知して」→ 通知送信を**提案** → 承認ボタンで実行
- 「最新のAIニュースを調べて」→ Web 検索（Grok キーが必要）を自動実行

### 承認ゲートについて
カレンダー登録・通知送信など**外部に作用する操作**は、AI が即実行せず、
HUB に「✅ 実行する / ❌ キャンセル」の承認 UI を出します（誤操作・事故防止）。
タスク更新・Vault保存・Web検索など内部／読み取り系は自動実行されます。

設定：`agent.py` の各ツールの `requires_confirmation` で挙動を変更できます。

---

## 7. 配布（複製）時のチェックリスト

- [ ] `.streamlit/secrets.toml` と `.env` が `.gitignore` に含まれている（含まれています）
- [ ] 配布版から Core Upgrade（`views/9_🚀_Core_Upgrade.py`）を除外（オーナー専用）
- [ ] 受け取った人が Settings → Secure Vault で各自の API キーを入力する運用にする
- [ ] Supabase は各自で新規作成（`supabase_schema.sql` を実行）

---

## 8. 実装ステータス

- ✅ マルチ AI 対応（`get_ai_response`：Gemini / Claude / Grok / OpenAI）
- ✅ Agent Engine（`agent.py`：`run_agent` + 5 ツール、承認ゲート付き）
- ✅ 全 view の AI 呼び出しを `get_ai_response` に統一
- ✅ 全ページ共通の会話履歴（`global_chat_history`）
- ✅ Secrets の `.env` / 環境変数フォールバック
- ⏳ （Phase 2）Vault / Dashboard / App Archive の Supabase 永続化
- ⏳ （Phase 2）Core Upgrade のバージョン管理（`core_versions`）
- ⏳ （Phase 3）自己進化提案エンジン / プラグインシステム
