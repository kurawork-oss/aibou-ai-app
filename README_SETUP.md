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

## 8. 💰 副業オートメーション（Mission Control）

HUB → AGENCY →「Auto Income」から開く、独立した副業オートメーション機能です。
1テーマから各プラットフォーム用メタデータをAIで一括生成し、**承認するだけで回る**
セミオート承認ステーション（要件定義書「アセット・マルチユース型 AI不労所得エコシステム」）。

### 8-1. 構成
| ファイル | 役割 |
|---|---|
| `income_engine.py` | 生成コア（脳）＋承認キュー管理。`agent.py` と同じく `register_services()` で Supabase / `get_ai_response` を注入。Supabase 未接続時は session_state にフォールバック。 |
| `views/10_💰_Auto_Income.py` | 管理画面（KPIカード / 承認Inbox / ✅承認・🗑️差し戻し / サイドバー稼働状況 / 手動トリガー）。 |
| Supabase `income_jobs` / `income_stats` | 承認キュー（pending/approved/rejected/completed/failed）と KPI。`supabase_schema.sql` 参照。 |

### 8-2. 動作（今回実装ぶん）
1. 「⚡ 新規生成トリガー」にテーマを入力（「🎲 AI提案」で自動提案も可）。
2. Gemini が Shutterstock(英語タイトル＋タグ50個以内) / YouTube(タイトル・概要・タイムスタンプ・ハッシュタグ) / note(H2/H3 Markdown記事) を**一括生成**し、承認待ち Inbox に積む。
3. プレビュー（タブ）を確認し「✅ 承認（配信キューへ）」or「🗑️ 差し戻して再生成」。
4. **冪等性**：同一テーマの重複生成を `dedupe_key` で防止。生成失敗は `failed` として記録し再試行可能。
5. **指数バックオフ**：AI生成は 5→10→20→40→60秒・最大5回リトライ（要件§3.1）。

### 8-3. アセット生成（`asset_engine.py`）
APIキー無し・オフラインでも実体アセットを生成できる（numpy / Pillow のみ）。
- `generate_ambient_wav(theme, duration_sec)`：テーマから種類を推定（雨/焚き火/風/波/ノイズ）し、
  numpy でノイズ合成 → 16bit WAV バイト列を返す。
- `generate_thumbnail(title, subtitle)`：PIL でグラデ背景＋テーマ文字のサムネ(1280x720) → PNG。
- `generate_image(prompt)`：`OPENAI_API_KEY` があれば画像生成API、無ければサムネにフォールバック。
- Mission Control の各承認待ちジョブに「🎨 アセット試作」（サムネ/環境音プレビュー）を追加。

### 8-4. 配信レイヤ（`publisher.py` + `scripts/` + GitHub Actions）
重い外部I/Oを常駐Streamlitから分離し、**バッチ側**で実行する。

| ファイル | 役割 |
|---|---|
| `scripts/nightly_generate.py` | 夜間cron。テーマを決めて生成→`income_jobs` に `pending` で積む。**配信はしない（安全）**。 |
| `publisher.py` | 配信レイヤ。`publish_job()` が note下書き / YouTube / Shutterstock をディスパッチ。指数バックオフ・冪等性・Discord通知つき。 |
| `scripts/run_publisher.py` | `approved` ジョブを取り出して `publish_job()` を実行（**手動トリガー専用**）。 |
| `.github/workflows/nightly-generate.yml` | 生成cron（毎日03:00 JST）＋手動。 |
| `.github/workflows/publish-approved.yml` | 配信（`workflow_dispatch` のみ。自動では走らない）。note下書きは成果物としてダウンロード可。 |

**コンプライアンス方針（厳守）**
- 公式手段のみ：YouTube Data API v3 / Shutterstock 公式コントリビューターFTPS。
- **note の非公式API自動投稿・「BAN回避（ボット検知回避）」は実装しない**（規約違反のため）。
  → 記事Markdown＋アイキャッチを `drafts/` に生成し、**投稿は人間が手動（ワンタップ）**で行う。
- 認証情報・アセットが無い配信先は必ず `skipped`。勝手な外部送信はしない。
- 公式アップロードが成功したジョブのみ `completed` に更新（それ以外は `approved` 据え置き）。

### 8-5. 必要な GitHub Secrets（Actions用）
| Secret | 用途 | 必須 |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_KEY` | キュー読み書き | ✅ |
| `GEMINI_API_KEY` | 夜間生成 | ✅（生成cron） |
| `DISCORD_WEBHOOK` | 完了/失敗通知 | 任意 |
| `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` | YouTube公式アップロード | 任意（設定時のみ有効） |
| `SS_FTP_HOST` / `SS_FTP_USER` / `SS_FTP_PASS` | Shutterstock公式FTPS | 任意（設定時のみ有効） |

> 動画・画像の**実レンダリング**（FFmpeg合成等）は次工程。現状 `run_publisher.py` はアセット未提供のため
> YouTube/Shutterstockは `skipped`、note下書きのみ生成される（安全に動く骨組み）。

---

## 9. 実装ステータス

- ✅ マルチ AI 対応（`get_ai_response`：Gemini / Claude / Grok / OpenAI）
- ✅ Agent Engine（`agent.py`：`run_agent` + 5 ツール、承認ゲート付き）
- ✅ 全 view の AI 呼び出しを `get_ai_response` に統一
- ✅ 全ページ共通の会話履歴（`global_chat_history`）
- ✅ Secrets の `.env` / 環境変数フォールバック
- ✅ 副業オートメーション：生成エンジン＋管理画面（`income_engine.py` / Auto Income）
- ✅ アセット生成（`asset_engine.py`：環境音 / サムネ / 画像）
- ✅ 配信レイヤの骨組み（`publisher.py`：公式API/規約準拠note下書き、指数バックオフ・通知）
- ✅ GitHub Actions：夜間生成cron（安全）＋配信（手動トリガー）
- ⏳ （次工程）動画・画像の実レンダリング（FFmpeg等）→ 公式アップロードの実投入
- ⏳ （Phase 2）Vault / Dashboard / App Archive の Supabase 永続化
- ⏳ （Phase 2）Core Upgrade のバージョン管理（`core_versions`）
- ⏳ （Phase 3）自己進化提案エンジン / プラグインシステム
