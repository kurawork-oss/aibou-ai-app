# バックエンド接続ガイド（いちばん簡単な手順）

アプリの各AI機能（チャット・Forge・Vault…）は「頭脳(Gemini)を呼ぶ経路」＝
**バックエンド(FastAPI, `api/`)** を1つ立てるだけで有効になります。
Geminiキーはサーバーに直書きしなくても、アプリの **KEYCHAIN** から同期できます。

---

## ステップ1：バックエンドをデプロイする

### 方法A：Render（推奨・ほぼワンクリック・無料）

1. <https://render.com> にGitHubでサインイン
2. **New → Blueprint** → このリポジトリ (`kurawork-oss/aibou-ai-app`) を選択
3. リポジトリ直下の [`render.yaml`](./render.yaml) を自動検出 → **Apply**
4. `GEMINI_API_KEY` を入力（[Google AI Studio](https://aistudio.google.com/apikey) で無料取得）。
   Supabase等は空欄でOK
5. デプロイ完了で URL が出ます 例：`https://aibou-brain-api.onrender.com`
   - ブラウザで `<URL>/health` を開き `{"status":"ok"}` が出れば成功
   - ※無料プランは無操作でスリープ。初回アクセスは数十秒かかります

### 方法B：Google Cloud Run（常時安定・従量）

リポジトリ直下で（`gcloud` 設定済み前提）:

```bash
gcloud run deploy aibou-brain \
  --source . \
  --dockerfile api/Dockerfile \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=あなたのキー
```

発行された `https://...run.app` がバックエンドURLです。

---

## ステップ2：Vercel に URL を登録

1. Vercel → プロジェクト → **Settings → Environment Variables**
2. 次を追加：

   | 変数 | 値 |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | ステップ1のURL（末尾スラッシュ無し） |
   | `NEXT_PUBLIC_API_TOKEN` | 任意（`APP_TOKEN` を設定した場合のみ同じ値） |

3. **Deployments → 最新 → Redeploy**（環境変数はビルド時に埋め込まれるため再デプロイ必須）

---

## ステップ3：アプリで確認

1. アプリを強制リロード → 画面上部が **● LINK ACTIVE**（緑）になる
   （Settings → DIAGNOSTICS の BACKEND が `CONFIGURED`）
2. **Settings → KEYCHAIN** で **Gemini API Key** を貼り付け **SAVE**
   → 自動でバックエンドに同期され、Geminiが即有効（サーバー再設定不要）
3. チャットに話しかけて返信が来れば完了 🎉

---

## セキュリティ強化（推奨・任意）

| 変数 | 場所 | 効果 |
| --- | --- | --- |
| `SUPABASE_JWT_SECRET` | Render（頭脳） | ログイン中のユーザーのJWTをAPI認証として検証（Supabase → Settings → API → JWT Secret の値） |
| `REQUIRE_AUTH=1` | Render（頭脳） | 上記JWT（または`APP_TOKEN`）が無いリクエストを401で拒否 — URLを知られても叩かれない |
| `BACKEND_URL` | GitHubリポジトリの Secrets | 10分ごとに/healthをpingしてRenderのスリープを防止（`backend-keepalive.yml`） |

`SUPABASE_JWT_SECRET` + `REQUIRE_AUTH=1` を設定すると、フロントはログインセッションのJWTを自動で使うため、
`NEXT_PUBLIC_API_TOKEN`（バンドルに露出する固定トークン）は不要になります。

## よくある詰まり

- **CORSエラー**：既定で全許可(`FRONTEND_ORIGIN=*`)なので通常出ません。絞る場合は
  Renderの `FRONTEND_ORIGIN` にVercelのURLを設定。
- **401 Unauthorized**：`APP_TOKEN` を設定したのに Vercel 側 `NEXT_PUBLIC_API_TOKEN`
  が未設定/不一致。両者を一致させる。
- **返信が来ない / OFFLINEのまま**：`NEXT_PUBLIC_API_URL` を設定後に **Redeploy** したか、
  URLの綴り（`https://`・末尾スラッシュ無し）を確認。`<URL>/health` が開けるかも確認。
- **無料Renderが遅い**：スリープからの復帰。初回だけ数十秒待つ。常時稼働が必要なら
  Cloud Run か Render 有料プランへ。
