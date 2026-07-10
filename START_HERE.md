# 🧭 はじめに — 初心者向けセットアップ（上から順にやればOK）

THE FORGE OS を動かすためにあなたがやることを、**最短の順番**でまとめました。
まず **Phase 1（AIを動かす）** だけ目指せば、チャットが使えるようになります。
Supabase保存や本格運用は後回しでOKです。

> 目安: 20〜30分 / 費用: 無料枠でOK / 必要アカウント: Google・GitHub

---

## 全体像（部品は3つ）

| 部品 | 何 | 状態 |
| --- | --- | --- |
| 🖥️ 画面（フロント） | Vercel | ✅ もう動いている |
| 🧠 頭脳（バックエンド） | FastAPI（`api/`）を Render等に立てる | ⬜ これから |
| 🗄️ 記憶（Supabase） | 既定プロジェクト `hwjmojipsablfevtjzln` | ⬜ 鍵を入れる |

「頭脳」は AI(Gemini) を呼ぶための小さなサーバーです。**これが無いと画面は出てもAIが返事できません**（今この状態）。

---

## 準備するもの（先に集める）

1. **Gemini APIキー（無料・必須）** … <https://aistudio.google.com/apikey> →「Create API key」→ コピー
2. **Supabaseの2つのキー（Phase 2で使用）** … プロジェクト `hwjmojipsablfevtjzln` の **Settings → API** から `anon public` と `service_role` をコピー

---

## Phase 1 ── AIを動かす（必須・まずここだけ）

### ① Geminiキーを取得
<https://aistudio.google.com/apikey> でキーを作成 → メモしておく。

### ② 頭脳（バックエンド）を Render に立てる
1. <https://render.com> にGitHubでログイン
2. **New → Blueprint** → リポジトリ `kurawork-oss/aibou-ai-app` を選択 → **Apply**
   （付属の `render.yaml` を自動で読み込みます）
3. 環境変数に **`GEMINI_API_KEY`** = ①のキー を入力
4. 数分でURL発行（例 `https://aibou-brain-api.onrender.com`）→ コピー
5. `そのURL/health` をブラウザで開き `{"status":"ok"}` が出れば成功

### ③ 画面（Vercel）に頭脳のURLを教える
1. Vercel → プロジェクト → **Settings → Environment Variables**
2. **`NEXT_PUBLIC_API_URL`** = ②のURL（末尾スラッシュ無し）を追加
3. **Deployments → 最新 → Redeploy**（← 環境変数は再デプロイで反映されます）

### ④ アプリで確認
1. 強制リロード（PCは `Ctrl/Cmd + Shift + R`）
2. 画面上部が **● LINK ACTIVE**（緑）になる
3. Settings(⚙) → **KEYCHAIN** で Geminiキーを貼り付けて **SAVE**
4. チャットで話しかけて返事が来たら **完成 🎉**

**✅ 完了の合図:** チャットがAIの返事を返す／上部が LINK ACTIVE。

---

## Phase 2 ── Supabaseに暗号化して保存（推奨）

キーやデータを **Supabaseに暗号化保存**し、再起動しても消えないようにします。
（KEYCHAINの見出しが「🔐 SUPABASE VAULT」に変わります）

### ① 自分のSupabaseプロジェクトを使う
新規に作ったプロジェクトでOKです。**プロジェクトURL**（Settings → API の Project URL）を控えて、
- Render（頭脳）の環境変数 **`SUPABASE_URL`** に設定
- Vercel（画面）の環境変数 **`NEXT_PUBLIC_SUPABASE_URL`** に設定 → Redeploy

（未設定時の既定は `hwjmojipsablfevtjzln`。自分のプロジェクトを使う場合は上の2つを**必ず**上書き）

### ② テーブルを作る（SQLを1回貼るだけ・約30秒）
Supabase → **SQL Editor** → リポジトリの [`supabase_schema.sql`](./supabase_schema.sql) の中身を**全部**貼って **Run**。
「Success. No rows returned」と出れば完了。全文 IF NOT EXISTS の冪等設計なので**何度実行しても安全**です。
（現行アプリが使う11テーブル＝api_keys / tasks / missions / automations / events / notifications /
vault_notebooks / income_jobs / studio_ais / studio_workflows / agent_memory がまとめて作成されます）

### ③ 頭脳(Render)にSupabaseの鍵を追加
Render → 該当サービス → **Environment** に:
- **`SUPABASE_SERVICE_KEY`** = service_role キー（秘密）
- **`KEYCHAIN_SECRET`** = 任意。好きな長い文字列（暗号化の固定鍵。設定すると再デプロイ後も復号可）

保存すると自動で再デプロイされます。

**✅ 完了の合図:** KEYCHAINが「🔐 SUPABASE VAULT」になり、DIAGNOSTICS の Supabase / DATABASE が緑。

---

## Phase 3 ── 本格運用（任意・あとで）

| やりたいこと | やること |
| --- | --- |
| メール＋パスワードで**ログイン** | Vercelに `NEXT_PUBLIC_SUPABASE_ANON_KEY`（anon public）を追加 → Redeploy。Supabase → Authentication → Email を有効化 |
| 副業自動化を**毎晩自動**で | GitHub Actions の cron で `/income/enqueue` を定期実行（INCOMEモードの案内参照） |
| APIを**他人に叩かれない**ように | Renderに `APP_TOKEN`、Vercelに同じ値の `NEXT_PUBLIC_API_TOKEN` |
| 常時**速く** | Render無料はスリープあり。Cloud Run か Render有料へ（`BACKEND_CONNECT.md` 参照） |

---

## 環境変数 早見表（どこに入れる？）

| 変数 | 場所 | 必須? |
| --- | --- | --- |
| `GEMINI_API_KEY` | Render（頭脳） | 必須 |
| `NEXT_PUBLIC_API_URL` | Vercel（画面） | 必須 |
| `SUPABASE_SERVICE_KEY` | Render（頭脳） | 推奨 |
| `KEYCHAIN_SECRET` | Render（頭脳） | 推奨 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel（画面） | 任意（ログイン用） |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | 既定 `hwjmojipsablfevtjzln`（変える時だけ） | 任意 |

アプリの **Settings → DIAGNOSTICS → CONNECTIONS** で、GitHub / Vercel / Supabase / Backend の接続状況を確認できます（緑=接続）。

---

## 困ったとき

- **ずっとOFFLINE / AIが返事しない** … `NEXT_PUBLIC_API_URL` 設定後に **Redeploy** したか、URLの綴り（`https://`・末尾 `/` 無し）、`URL/health` が開けるか確認。
- **Renderが遅い** … 無料はスリープあり。初回だけ数十秒待てば復帰。
- **401 Unauthorized** … `APP_TOKEN` と `NEXT_PUBLIC_API_TOKEN` を同じ値にして Redeploy。
- **Supabaseが開けない** … 別アカウント所有かも。新規プロジェクトを作って使う（Phase 2 ①）。
- **最新か確認** … DIAGNOSTICS の `BUILD` が最新（例 `2026.06.27 · ui-r10`）ならOK。

詳細版: `BACKEND_CONNECT.md` / `SETUP.md`
