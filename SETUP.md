# THE FORGE OS — 接続セットアップ（ログイン & データベース）

このアプリは「設定が無くても落ちない」設計です。以下を設定すると、実ログインと
データ永続化（Supabase）、AI機能（Gemini）が有効になります。

## 1. Supabase（データベース）

プロジェクト: `hwjmojipsablfevtjzln`
（API URL: `https://hwjmojipsablfevtjzln.supabase.co`）

### 1-1. スキーマを作成
Supabase ダッシュボード → **SQL Editor** で、リポジトリ直下の
[`supabase_schema.sql`](./supabase_schema.sql) を貼り付けて実行する。
（tasks / studio_ais / studio_workflows / api_keys / missions / automations /
events / notifications / vault_notebooks / income_jobs / agent_memory を作成）

### 1-2. キーを控える
ダッシュボード → **Project Settings → API** から:
- **Project URL** … `https://hwjmojipsablfevtjzln.supabase.co`
- **anon public** … フロント（ログイン）用
- **service_role** … バックエンド（DB読み書き）用 ※秘密

## 2. フロントエンド（Vercel）の環境変数

Vercel → Project → **Settings → Environment Variables** に設定:

| 変数 | 値 | 用途 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://hwjmojipsablfevtjzln.supabase.co` | ログイン（Supabase Auth） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public キー | ログイン |
| `NEXT_PUBLIC_API_URL` | バックエンドのURL（後述） | 各機能のAPI |
| `NEXT_PUBLIC_API_TOKEN` | 任意（Bearer保護する場合） | API認証 |

- この2つ（URL + ANON KEY）が揃うと EntryGate が **実ログイン**（メール+パスワードの
  サインイン / サインアップ）に切り替わります。未設定なら従来のソフトゲート（ENTER）。
- Supabase → Authentication → Providers で **Email** を有効化してください。

## 3. バックエンド（FastAPI / Cloud Run など）の環境変数

| 変数 | 値 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini APIキー（チャット・生成の頭脳） |
| `SUPABASE_URL` | `https://hwjmojipsablfevtjzln.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role キー |
| `APP_TOKEN` | 任意（フロントの `NEXT_PUBLIC_API_TOKEN` と一致させる） |
| `FRONTEND_ORIGIN` | 任意（CORS制限する場合、Vercelのドメイン） |

> Gemini キーは、アプリ内 **Settings → KEYCHAIN** からも保存できます
> （バックエンド接続後）。`api_keys` テーブルに保管され、即時に有効化されます。

## 4. つながると有効になるもの

- **ログイン**: メール認証（Supabase Auth）
- **HOME**: タスク/ミッション/自動化/副業/予定/通知の実データ集約
- **チャット / Forge / Vault / Studio / AUTO / BOARD**: Gemini による実生成
- **オートパイロット**: 完了・失敗時に LINE / Discord / Slack へ通知
  （各トークンは KEYCHAIN に保存）
- **24時間の常時自動実行**: cron / GitHub Actions から
  `POST /autopilot/missions/{id}/step` を定期実行

## 5. ローカル開発

`webapp/.env.local` に上記 `NEXT_PUBLIC_*` を置く。バックエンドは `api/` で
`uvicorn main:app --reload`（`.env` に `GEMINI_API_KEY` 等）。
