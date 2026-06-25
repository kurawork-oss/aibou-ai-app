# THE FORGE OS — JARVIS最終形 ブループリント

無料・UI/UX最高・全機能を狙った構成。既存Streamlitの世界観（黒地×銀枠×淡い青白グロー）を
継承しつつ、**Next.js(PWA)の顔 × FastAPIの頭脳 × Supabaseの記憶**に進化させる。

```
FRONT  webapp/   Next.js + Vercel (PWA)      … HUD/コア球/常時音声/画像/ストリーミング/スマホ常駐
  │  REST + SSE (Authorization: Bearer APP_TOKEN)
BRAIN  api/      FastAPI + Cloud Run/HF Spaces … 会話(stream)/視覚/TTS/記憶/収益/動画(ffmpeg)
  │
DATA   Supabase  Postgres + pgvector + Storage + Auth + Realtime … 唯一の正本
AUTO   GitHub Actions … 毎朝ブリーフィング/夜間生成/監視/配信（既存）
AI     Gemini(手持ち) + edge-tts/Web Speech(無料音声)
```

既存Streamlit(リポジトリ直下)は**当面そのまま**残し、新フロントが揃ったら主役を切替える。
Python資産（`agent.py`/`memory.py`/`income_engine.py`/`renderer.py`）はAPIから再利用/移植する。

---

## ディレクトリ
- `api/` … FastAPIバックエンド（自己完結・Streamlit非依存）。`api/README.md` 参照。
- `webapp/` … Next.jsフロント（PWA）。`webapp/README.md` 参照。
- `supabase/migrations/20260625000000_jarvis_pgvector.sql` … 意味記憶(pgvector)＋成果物ストレージ。
- 既存 `supabase_schema.sql` … 先に実行（vault/agent_memory/income等）。

## バックエンド API（`api/`）
エンドポイント：
- `GET /health` … フロントのブート画面がこれを叩いて起動完了を待つ（コールドスタート吸収）
- `POST /chat`（SSE）… `{message, history?, persona?, name?}` をトークン逐次返答。記憶想起＋人格注入。応答後に記憶へ保存
- `POST /vision` … 画像(base64)＋指示をGeminiで理解
- `POST /tts` … edge-ttsで音声(mp3 base64)
- `POST /memory/add` / `GET /memory/recent` … agent_memory
- `GET /income/summary` … income_jobs の状態別件数
- `POST /video` … 既存 `renderer.render_forge_video` で画像＋ナレーションMP4

環境変数：`GEMINI_API_KEY` / `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `APP_TOKEN`(任意・APIガード) / `FRONTEND_ORIGIN`。

## フロント（`webapp/`）
- ブート画面 `BootScreen`：`/health` を1.5秒間隔でポーリングし、FORGE OSスプラッシュ（脈動するコア球＋"BOOTING…"）を表示。
  → **無料バックエンドのコールドスタートを必ずブランドのロード画面で隠す**（UIラグを見せない）。
- `CoreOrb`：淡い青白グローのコア球（idle/listening/speaking/thinking で発光変化）。
- `Chat`：ストリーミング会話／🎤Web Speechで常時音声／📷画像。
- PWA：`manifest.webmanifest`＋テーマ #0a0b0f。スマホにインストール可。

環境変数（Vercel）：`NEXT_PUBLIC_API_URL`（バックエンドURL）/ `NEXT_PUBLIC_API_TOKEN`（APP_TOKENと一致）。

---

## デプロイ手順（すべて無料枠）

### 1. Supabase（データ・記憶・ストレージ）
1. SQL Editor で `supabase_schema.sql` を実行（未実行なら）。
2. 続けて `supabase/migrations/20260625000000_jarvis_pgvector.sql` を実行（pgvector＋forge-assetsバケット）。
3. `SUPABASE_URL` と **service_role** キーを控える。

### 2. バックエンド（Cloud Run 推奨 / HF Spaces 代替）
- Cloud Run（無料枠・60分・ffmpeg可・ゼロスケール）：
  ```
  # リポジトリ直下で（Dockerfileが root の renderer.py を取り込むため）
  gcloud run deploy forge-brain --source . --dockerfile api/Dockerfile \
    --region asia-northeast1 --allow-unauthenticated \
    --set-env-vars GEMINI_API_KEY=...,SUPABASE_URL=...,SUPABASE_SERVICE_KEY=...,APP_TOKEN=...,FRONTEND_ORIGIN=https://<your-vercel-app>
  ```
  発行されたURLが `NEXT_PUBLIC_API_URL`。
- HF Spaces（最も簡単）：Docker Space を作り `api/` を配置（Dockerfileの起点に注意：renderer.py も同梱）。Secretsに同じ環境変数。

### 3. フロント（Vercel）
1. Vercel で `webapp/` を Import（Root Directory = `webapp`）。
2. 環境変数：`NEXT_PUBLIC_API_URL`=バックエンドURL、`NEXT_PUBLIC_API_TOKEN`=APP_TOKEN。
3. Deploy。発行URLを backend の `FRONTEND_ORIGIN` に設定（CORS）。
4. PWAアイコン：`assets/aibou_icon.png` を `webapp/public/icon-192.png` / `icon-512.png` にコピー。

### 4. 自動化（既存のまま）
GitHub Actions（nightly生成・日次要約等）は継続。将来「毎朝ブリーフィング→Web Push」を追加。

---

## コールドスタート対策（UIラグを見せない）
無料の常駐バックエンドはアイドル後の初回が数秒。`BootScreen` が `/health` を待つ間
FORGE OSの起動演出を出すため、ユーザーには“ラグ”ではなく“起動シーケンス”に見える。
（任意：GitHub Actions の keepalive で定期 ping して眠らせない運用も可）

## ロードマップ（このブループリント以降）
- [ ] `/chat` にツール実行（カレンダー/タスク/通知/副業）を移植（既存 agent.py のツール群）
- [ ] pgvector意味記憶をバックエンドで使用（埋め込み生成＋match_memories）
- [ ] Forge（アプリ/画像/動画/スライド/表/文書）をフロントUI化＋Storage保存
- [ ] プロアクティブ（毎朝ブリーフィング＋Web Push）
- [ ] Realtimeでタスク/収益のライブ更新
