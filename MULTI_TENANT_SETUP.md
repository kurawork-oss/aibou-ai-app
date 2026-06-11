# マルチアカウント化 セットアップ手順（Supabase Auth ＋ Stripe）

このアプリを「複数ユーザーで使う／アカウント毎にデータを分ける／自己進化はオーナー専用／
Auto Income は課金者のみ」にするための設定です。**コードは導入済み**で、下記の設定を行い
最後に `AUTH_MODE=supabase` に切り替えると有効になります（切り替えるまでは従来の共有
パスワードのまま動くので、途中で壊れません）。

---

## 0. 全体像
- 認証：**Supabase Auth（メール＋パスワード）**。新規登録時に**利用規約への同意**を必須化。
- 権限：**最初に登録したアカウント＝オーナー（あなた）**。以降は一般ユーザー。
- データ分離：**RLS（行レベルセキュリティ）**で各ユーザーは自分のデータのみ閲覧可
  （APIキー金庫・ノート・ボード・生成アプリ・収益ジョブ等）。オーナーは管理目的で全件閲覧可。
- 自己進化（Core Upgrade）：**オーナー専用**。
- Auto Income：**オーナーは無料／他ユーザーは Stripe サブスク課金で解放**（手動解放も可）。

---

## 1. Supabase Auth を有効化
Supabase ダッシュボード → **Authentication → Providers → Email** を有効化。
- テスト中は **「Confirm email」をOFF**にすると、登録後すぐログインできて確認が楽です
  （本番運用では ON 推奨）。

## 2. マイグレーション（テーブル＆RLS）を適用
お手元で：
```bash
supabase link --project-ref hwjmojipsablfevtjzln
supabase db push
```
または Dashboard → **SQL Editor** で以下を順に実行：
1. `supabase/migrations/20260610000000_init_schema.sql`
2. `supabase/migrations/20260610010000_multitenant.sql`

## 3. アプリの Secrets（Streamlit Cloud → Settings → Secrets / または .env）
```toml
SUPABASE_URL = "https://hwjmojipsablfevtjzln.supabase.co"
SUPABASE_ANON_KEY = "（anon / publishable キー）"   # ★RLSのためアプリはこれを使う
MASTER_ENCRYPTION_KEY = "（既存のものを流用）"
OWNER_EMAIL = "あなたのメールアドレス"               # 最初の登録者を確実にオーナーへ（保険）
AUTH_MODE = "supabase"                              # ★最後にこれで本番を認証モードに切替

# Stripe（Auto Income 課金）
STRIPE_SECRET_KEY = "sk_live_... または sk_test_..."
STRIPE_PRICE_ID  = "price_...（サブスクのPrice ID）"
APP_BASE_URL     = "https://<あなたのアプリ>.streamlit.app"   # 決済後の戻り先
```
> 補足：headless（GitHub Actions）側の `SUPABASE_KEY` は**サービスロールキー**のままにします
> （自動化は RLS をバイパスして動かすため）。アプリと headless でキーを分けるのが正解です。

## 4. Stripe（サブスク商品）
1. Stripe ダッシュボードで**商品（定期/サブスク）**を作成 → **Price ID** を取得 → `STRIPE_PRICE_ID` へ。
2. `STRIPE_SECRET_KEY` を設定。
3. （推奨）Webhook：`supabase/functions/stripe-webhook` をデプロイして、解約・支払い失敗を
   即時反映：
   ```bash
   supabase functions deploy stripe-webhook --no-verify-jwt
   supabase secrets set STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... \
       SUPABASE_URL=https://hwjmojipsablfevtjzln.supabase.co \
       SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
   ```
   Stripe → Developers → Webhooks にこの関数URLを登録し、
   `checkout.session.completed` / `customer.subscription.*` を購読。
   ※ Webhook を設定しなくても、アプリはアクセス時に Stripe へ問い合わせて状態を同期します
   （`billing.sync_status`）。

## 5. 切り替え＆初回オーナー登録
1. Secrets に `AUTH_MODE = "supabase"` を反映してアプリを再起動。
2. **あなたが最初に「新規登録」**してください → 自動的に **owner** になります。
3. 以降に登録した人は一般ユーザー（Auto Income は課金、自己進化は不可）。

---

## 動作確認チェックリスト
- [ ] 新規登録で規約同意が必須になっている
- [ ] 最初のアカウントが Settings → 👑 ユーザー管理 を表示できる（= owner）
- [ ] 2人目のアカウントでは Evolution が出ず、Auto Income が 🔒（課金導線）になる
- [ ] APIキー（Secure Vault）がアカウント毎に分かれて保存される
- [ ] Stripe 決済後に Auto Income が解放される（または 👑 ユーザー管理で手動有効化）

## オーナーができる管理（Settings → 👑 ユーザー管理）
- 登録ユーザーの一覧表示
- 各ユーザーの **owner 昇格/解除**
- 各ユーザーの **課金を手動で有効化/無効化**（Stripe を介さない管理用スイッチ）

## 注意・既知の制限（Phase 2 候補）
- Auto Income の**データ**（生成キュー/KPI）はアカウント毎に分離されますが、各プラット
  フォームへの**実配信**（YouTube/Shutterstock 等）は当面オーナー設定の公式キーを共用します。
  ユーザー毎の配信先・自動運転は Phase 2 で拡張可能です。
- Supabase Auth のトークンは約1時間で失効します（自動リフレッシュ実装済み。失効時は再ログイン）。
