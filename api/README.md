# AIbou Brain API

JARVIS 的なパーソナル AI アシスタントの「脳」となる、スタンドアロンな **FastAPI** バックエンドです。
Next.js などのフロントエンドがこの API を叩いて、ストリーミング会話・画像理解・音声合成・長期記憶・副業ジョブ集計・動画生成を利用します。

- **自己完結**: Streamlit や `core.py` には依存しません。
- **落ちない設計**: 設定（APIキー等）が欠けていても crash せず、わかりやすい JSON エラーを返します。
- **無料デプロイ向け**: ffmpeg 入りコンテナで Google Cloud Run / Hugging Face Spaces にデプロイできます。

---

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `GEMINI_API_KEY` | chat/vision に必要 | Google Generative AI（Gemini）の API キー |
| `SUPABASE_URL` | memory/income に必要 | Supabase プロジェクト URL |
| `SUPABASE_SERVICE_KEY` | memory/income に必要 | Supabase の **service role** キー |
| `APP_TOKEN` | 任意 | 設定すると `/health` 以外で `Authorization: Bearer <APP_TOKEN>` を要求 |
| `FRONTEND_ORIGIN` | 任意 | CORS 許可オリジン（既定 `*`、カンマ区切りで複数可） |
| `GEMINI_MODEL` | 任意 | 既定 `gemini-2.5-flash` |
| `DEFAULT_TTS_VOICE` | 任意 | 既定 `ja-JP-KeitaNeural` |
| `PORT` | 任意 | リッスンポート（Cloud Run が自動注入。既定 `8080`） |

`.env.example` をコピーして `.env` を作成してください（`python-dotenv` が自動ロードします）。

Supabase のテーブルはリポジトリ root の `supabase_schema.sql`（`agent_memory` / `income_jobs`）を利用します。

---

## ローカル実行

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 値を埋める

uvicorn main:app --reload --port 8080
```

- ヘルスチェック: `curl http://localhost:8080/health` → `{"status":"ok"}`
- `/video` をローカルで使うには `ffmpeg` がインストールされている必要があります。

> 注: `/video` はリポジトリ root の `renderer.py` を再利用します。ローカルでは親ディレクトリを
> 自動的に `sys.path` に追加して import します（`api/` の1つ上に `renderer.py` がある前提）。

---

## エンドポイント契約（フロント統合用）

すべて JSON（`/chat` のみ SSE）。`APP_TOKEN` 設定時は `/health` 以外で
`Authorization: Bearer <APP_TOKEN>` ヘッダが必須です。

### `GET /health`
認証不要。コールドスタート温め用。
```json
{ "status": "ok" }
```

### `POST /chat`  （SSE ストリーミング / `text/event-stream`）
リクエスト:
```json
{
  "message": "今日の予定を整理して",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "persona": "冷静で簡潔な執事",
  "name": "AIbou"
}
```
レスポンス（SSE イベント列）:
```
data: {"token": "了"}

data: {"token": "解しました"}

data: {"done": true}
```
- トークンは `data: {"token": "..."}` で逐次届きます。
- 完了は `data: {"done": true}`。
- サーバ側エラー時は `data: {"error": "..."}` の後に `data: {"done": true}`。
- 応答後、ユーザー発話と最終アシスタント応答を `agent_memory` に best-effort で保存します。

### `POST /vision`
```json
{ "prompt": "この画像を説明して", "image_base64": "<base64>", "mime": "image/jpeg" }
```
→ `{ "text": "..." }`  （Gemini 未設定時は 503、base64 不正時は 400）

### `POST /tts`
```json
{ "text": "こんにちは", "voice": "ja-JP-KeitaNeural" }
```
→ `{ "audio_base64": "<mp3 base64>" }`  （失敗時は `{ "audio_base64": "", "error": "..." }`）

### `POST /memory/add`
```json
{ "role": "fact", "content": "ユーザーの誕生日は1月1日", "importance": 1 }
```
→ `{ "ok": true }`  （Supabase 未設定時は `{ "ok": false, "error": "..." }`）

### `GET /memory/recent?limit=20`
→ `{ "items": [ { "id": "...", "role": "user", "content": "...", "importance": 0, "created_at": "..." } ] }`
（Supabase 未設定時は `{ "items": [] }`）

### `GET /income/summary`
→
```json
{ "pending": 3, "approved": 1, "rejected": 0, "completed": 5, "failed": 0, "total": 9 }
```
（Supabase 未設定 / テーブル無しなら `{}`）

### `POST /video`
```json
{
  "scenes": [{ "narration": "日本語ナレーション", "visual": "english visual prompt" }],
  "image_prompt": "cinematic, 4k"
}
```
→ `{ "video_base64": "<mp4 base64>" }`
（ffmpeg / renderer が無い、または生成失敗時は 503 `{ "error": "video rendering unavailable" }`）

---

## デプロイ

ビルドはリポジトリ **root** から行います（`renderer.py` を同梱するため）。

### Google Cloud Run

```bash
# リポジトリ root で
gcloud builds submit --tag gcr.io/<PROJECT_ID>/aibou-brain -f api/Dockerfile .

gcloud run deploy aibou-brain \
  --image gcr.io/<PROJECT_ID>/aibou-brain \
  --platform managed \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=...,SUPABASE_URL=...,SUPABASE_SERVICE_KEY=...,APP_TOKEN=...,FRONTEND_ORIGIN=https://your-frontend.example
```
Cloud Run は `$PORT` を自動注入します（Dockerfile が対応済み）。

### Hugging Face Spaces（Docker SDK）

1. **SDK: Docker** で Space を作成。
2. このリポジトリを push し、Space の Dockerfile としてこの `api/Dockerfile` を使う構成にする
   （root を build context にし、`renderer.py` を含める）。
3. Space の **Settings → Variables and secrets** に `GEMINI_API_KEY` などを登録。
4. HF Spaces は通常ポート **7860** を使います。`PORT=7860` を環境変数に設定してください
   （Dockerfile は `${PORT:-8080}` を展開するので、それで自動的に 7860 で起動します）。

---

## 注意

- このイテレーションではツール呼び出し / エージェントループは未実装です（後続で追加予定）。
  まずは streaming chat + vision + tts + memory + income summary + video に集中しています。
- すべてのエンドポイントは設定欠如時に crash せず、JSON エラーや空レスポンスで縮退します。
