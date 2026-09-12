-- =====================================================================
-- THE FORGE OS — Supabase テーブル定義（このファイル1つで全部そろう）
--
-- 使い方（新規プロジェクト初期化・約30秒）:
--   1. Supabase ダッシュボード → 対象プロジェクト → SQL Editor
--   2. このファイルの中身を全部コピーして貼り付け → RUN
--   3. 「Success. No rows returned」と出れば完了
--
-- ・全文 IF NOT EXISTS の冪等設計 — 何度実行しても安全（既存データは消えない）
-- ・現行アプリ(FastAPI)が使うのは: api_keys / tasks / missions / automations /
--   events / notifications / vault_notebooks / income_jobs / studio_ais /
--   studio_workflows / agent_memory / life_entries の12テーブル
--   （vault_data / dashboard_boards / forge_apps / core_versions /
--     evolution_proposals / income_stats は旧Streamlit版の互換用。あっても無害）
-- ・api_keys.value にはサーバー側でFernet暗号化された暗号文が入る（平文は不保存）
-- ・アクセスはバックエンドの service_role キー経由のみ。RLSポリシー未設定でも
--   anon キーからはテーブルに触れないため安全（ログインは Supabase Auth を使用）
-- =====================================================================

-- 【Phase 1 / 必須】APIキーの暗号化保存（現状アプリが使う唯一のテーブル）
-- core.py の load_vault() / save_vault() が id=1 の1行を upsert して使う。
CREATE TABLE IF NOT EXISTS vault_data (
  id            int PRIMARY KEY,
  encrypted_keys text
);

-- 【Phase 2】Document Vault のノートブック永続化
CREATE TABLE IF NOT EXISTS vault_notebooks (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text NOT NULL,
  docs       jsonb DEFAULT '{}'::jsonb,
  chat       jsonb DEFAULT '[]'::jsonb,
  updated_at timestamp DEFAULT now()
);

-- 【Phase 2】Dashboard（Miroボード）の永続化 — 1行=1ボード（複数ボード対応）
CREATE TABLE IF NOT EXISTS dashboard_boards (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text DEFAULT 'ボード',
  nodes      jsonb DEFAULT '[]'::jsonb,
  edges      jsonb DEFAULT '[]'::jsonb,
  updated_at timestamp DEFAULT now()
);
-- 既存テーブルへの後方互換アップグレード（自動マイグレーションで反映）
ALTER TABLE dashboard_boards ADD COLUMN IF NOT EXISTS name text DEFAULT 'ボード';

-- 【Phase 2】App Archive（生成ミニアプリ）の永続化（Streamlit Cloud対応）
CREATE TABLE IF NOT EXISTS forge_apps (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  filename   text NOT NULL,
  code       text NOT NULL,
  created_at timestamp DEFAULT now()
);

-- 【Phase 2】Core Upgrade のバージョン履歴（自己書き換えのロールバック用）
CREATE TABLE IF NOT EXISTS core_versions (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  version_label text,
  core_code     text NOT NULL,
  created_at    timestamp DEFAULT now()
);

-- 【Phase 3】自己進化提案エンジンの提案ログ
CREATE TABLE IF NOT EXISTS evolution_proposals (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  proposal   text,
  source     text,
  status     text DEFAULT 'pending',
  created_at timestamp DEFAULT now()
);

-- =====================================================================
-- 💰 副業オートメーション（Mission Control）
-- income_engine.py が使う。承認キュー＋KPIの2テーブル。
-- =====================================================================

-- 生成アセットの承認キュー。status: pending/approved/rejected/completed/failed
-- payload に各プラットフォーム用メタデータ（shutterstock/youtube/note）をJSONで格納。
-- dedupe_key でテーマの重複生成を防ぐ（冪等性／要件§3.1）。
CREATE TABLE IF NOT EXISTS income_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text,
  theme      text NOT NULL,
  status     text DEFAULT 'pending',
  payload    jsonb DEFAULT '{}'::jsonb,
  log        text DEFAULT '',
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_income_jobs_status ON income_jobs(status);
CREATE INDEX IF NOT EXISTS idx_income_jobs_dedupe ON income_jobs(dedupe_key);

-- KPI（収益/PV/稼働開始日）保持。id=1 の1行を upsert して使う。
CREATE TABLE IF NOT EXISTS income_stats (
  id   int PRIMARY KEY,
  data jsonb DEFAULT '{}'::jsonb
);

-- =====================================================================
-- 🧠 長期記憶（“覚えてるJARVIS”）
-- memory.py が会話の各ターンと remember() の事実をここへ保存し、毎ターン関連記憶を
-- 想起してシステムプロンプトへ注入する。単独利用向けに user_id は text（既定 'local'）。
-- ※ 複数ユーザー/RLSで運用する場合は supabase/migrations/ の agent_memory（uuid+RLS）を使う。
-- =====================================================================
-- ME モード「経験の箱」— 本人の経歴/お金/人間関係/価値観などの長期プロファイル。
-- 相談チャット(/life/chat)の system prompt に常に注入される。
CREATE TABLE IF NOT EXISTS life_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category   text DEFAULT 'other',   -- career|money|relationships|health|values|events|other
  content    text NOT NULL,
  entry_date text DEFAULT '',        -- 任意の時期表記（例 "2024-04" "高校時代"）
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_life_entries_cat ON life_entries(category, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text DEFAULT 'local',
  role       text,                 -- 'user' | 'assistant' | 'fact'
  content    text,
  importance int DEFAULT 0,        -- >=1 は優先想起（remember で登録した事実）
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_user ON agent_memory(user_id, created_at DESC);

-- 端末と合流させるための2列。
--   updated_at … 「前回の合流より後に変わった物」を引くための目印
--   deleted_at … 墓標。行ごと消すと、次の合流で端末側から復活してしまう
-- 端末（IndexedDB）と同じ形にしてある。id は端末が作った UUID をそのまま使う
-- ので、対応表は要らない。
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_agent_memory_sync ON agent_memory(user_id, updated_at DESC);

-- =====================================================================
-- 🚀 Next.js webapp（FastAPI バックエンド）が使う新テーブル
-- これらが無くてもアプリはメモリ・フォールバックで動くが、
-- 永続化するには SQL Editor でこのブロックを実行する。
-- =====================================================================

-- ⚡ アクティブタスク（Tasks）
CREATE TABLE IF NOT EXISTS tasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  content    text DEFAULT '',
  status     text DEFAULT 'pending',   -- pending/in_progress/awaiting_approval/completed/cancelled
  response   text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at DESC);
-- プロジェクト管理の拡張列（既存テーブルへの後方互換アップグレード）
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority text DEFAULT 'mid';   -- high|mid|low
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due text DEFAULT '';           -- YYYY-MM-DD
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project text DEFAULT '';       -- グループ名

-- 🪝 外から動かすためのトリガー（Webhook）
-- URLを1つ知られただけで何でもできる、にはしない。
-- 起動できるのは、あらかじめ結びつけた自動化1つだけ。
CREATE TABLE IF NOT EXISTS hooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id     text NOT NULL,
  user_id      text DEFAULT '',
  automation_id text NOT NULL,
  label        text DEFAULT '',
  uses         integer DEFAULT 0,
  last_used_at text DEFAULT '',
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hooks_token ON hooks(token_id);

-- agent_rules … 「AIbouに守らせるルール」。GitHub（Obsidianの保管庫）から取り込む。
-- 人が書いたメモをそのまま行動指針にするための置き場で、AIbouは読むだけ・書かない。
-- 同期のたびに丸ごと入れ替える（消したメモが残らないように）。
CREATE TABLE IF NOT EXISTS agent_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path       text NOT NULL,
  title      text DEFAULT '',
  applies    text DEFAULT 'always',   -- always / tool / mode / topic
  targets    text DEFAULT '',         -- 適用先をカンマ区切りで（tool名 / モード名 / 言葉）
  body       text DEFAULT '',
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_rules_applies ON agent_rules(applies);

-- 👀 watch_state … 見張りの「どこまで見たか」。
-- 品目ごとの鍵を覚えておき、次に見たとき増えたぶんだけを報せる。
-- これが無いと毎回ぜんぶ並べることになり、2回目から誰も読まなくなる。
CREATE TABLE IF NOT EXISTS watch_state (
  source     text PRIMARY KEY,         -- tasks / agenda / work / mail / slack / line
  enabled    boolean DEFAULT true,
  seen       jsonb DEFAULT '[]'::jsonb,-- 見たことのある品目の鍵（新しい順・上限あり）
  items      jsonb DEFAULT '[]'::jsonb,-- 前回見えていた中身。画面を開くたびに
                                       -- メールやSlackへ繋ぎ直さないための控え
  last_error text DEFAULT '',          -- 前回読めなかった理由。同じ失敗を鳴らし続けないため
  last_run   text DEFAULT '',
  started    boolean DEFAULT false,    -- 初回は一斉通知を出さないための印
  setup_needed boolean DEFAULT false,  -- 未設定（失敗ではない）ことの控え
  updated_at timestamptz DEFAULT now()
);


-- 📥 inbox_messages … 外から届いたメッセージ（いまはLINE）。
-- LINEのMessaging APIは「送る」と「受け取る」が別の口で、受け取りは
-- LINE側からこちらへPOSTしてもらう形になる。その置き場。
CREATE TABLE IF NOT EXISTS inbox_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL DEFAULT 'line',
  sender      text DEFAULT '',
  text        text DEFAULT '',
  external_id text DEFAULT '',         -- 送り主が付けたID。同じものを二重に入れない
  ts          text DEFAULT '',
  read        boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_channel ON inbox_messages(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_external ON inbox_messages(external_id);

-- 🔁 setup_sessions … 連携待ちで預かった用事。
-- 「Notionから資料探して」→ 未接続 → 連携 → **元の用事に戻る** を成立させる。
-- ここが無いと、利用者は戻ってきてから同じ頼みごとを言い直すことになる。
CREATE TABLE IF NOT EXISTS setup_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,           -- google / slack / notion / github
  instruction text NOT NULL,           -- 預かった頼みごと
  tool        text DEFAULT '',         -- 途中まで進んでいた道具
  params      text DEFAULT '',         -- そのときの引数（JSON文字列）
  status      text DEFAULT 'waiting',  -- waiting / resumed / expired
  created_at  double precision,
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_setup_sessions_status ON setup_sessions(status, created_at DESC);

-- あとから足した列。既に watch_state を作ってある人にも当たるようにする
-- （CREATE TABLE IF NOT EXISTS だけだと、既存の表には列が増えない）。
ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS items jsonb DEFAULT '[]'::jsonb;
ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS setup_needed boolean DEFAULT false;



-- 💬 CHAT：会話履歴
-- 端末を変えても続きから読めるように、その人のDBに残す。
-- 本文は jsonb に丸ごと入れる（1件ずつ読み書きするので、行を分ける利点が薄い）。
CREATE TABLE IF NOT EXISTS conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text DEFAULT '',
  messages   jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

-- ✦ AI Studio：カスタムAI
CREATE TABLE IF NOT EXISTS studio_ais (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  persona    text DEFAULT '',
  model      text DEFAULT 'gemini-2.5-flash',
  rules      text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- ✦ AI Studio：ワークフロー（多段プロンプト連鎖）
CREATE TABLE IF NOT EXISTS studio_workflows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  steps      jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- 🔐 APIキー保管庫（Keychain）。値はサーバー側専用、APIではマスクのみ返す。
CREATE TABLE IF NOT EXISTS api_keys (
  name       text PRIMARY KEY,
  value      text DEFAULT '',
  updated_at timestamptz DEFAULT now()
);

-- 🛰 オートパイロット：ゴール自動実行ミッション
CREATE TABLE IF NOT EXISTS missions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal       text NOT NULL,
  status     text DEFAULT 'active',    -- active/completed/failed/paused
  steps      jsonb DEFAULT '[]'::jsonb,
  current    int DEFAULT 0,
  log        jsonb DEFAULT '[]'::jsonb,
  notify     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, created_at DESC);

-- 🔀 ノーコード自動化（Zapier風フロー）
CREATE TABLE IF NOT EXISTS automations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  enabled    boolean DEFAULT true,
  trigger    jsonb DEFAULT '{}'::jsonb,
  steps      jsonb DEFAULT '[]'::jsonb,
  status     text DEFAULT 'idle',
  log        jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- 📅 組み込みカレンダー（Agenda）
CREATE TABLE IF NOT EXISTS events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  date       text DEFAULT '',
  time       text DEFAULT '',
  note       text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

-- 🔔 アプリ内通知（Notifications）
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message    text DEFAULT '',
  channel    text DEFAULT 'system',
  read       boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);

-- 🔔 端末への通知の宛先（Web Push）
--
-- 「この端末に通知を届けてよい」という許可そのもの。endpoint がその端末の
-- 郵便受けで、p256dh と auth はその端末だけが開ける鍵（本文はこの2つで
-- 暗号化して送るので、経路の途中では中身が読めない）。
--
-- endpoint を主キーにしているのは、同じ端末を何度登録しても1行にするため。
-- 端末が通知を切ると push サービスが 404/410 を返すので、その時点でこの行は
-- サーバー側から消える（持ち続けても二度と届かない）。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   text PRIMARY KEY,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  label      text DEFAULT '',          -- どの端末か（ブラウザ名など。人が見る用）
  created_at timestamptz DEFAULT now()
);

-- ✋ 承認待ち（Approvals）
--
-- 取り返せない操作は必ず人に聞く（risk.py）。画面の前に居ないとき——
-- 深夜の定期実行など——は、その用事をここに置いて通知で知らせる。
--
-- token は通知の中にだけ入れる使い捨ての合言葉。サービスワーカーには
-- 画面のログイン情報が渡らないので、これが「その端末の持ち主である」
-- 証明になる。答え終わったら空にする（1回きり）。
-- user_id は実行するときに戻る保存先（定期実行は人ごとに切り替えながら
-- 回るので、控えておかないと別の人のDBに対して実行してしまう）。
CREATE TABLE IF NOT EXISTS approvals (
  id         text PRIMARY KEY,
  tool       text NOT NULL,
  params     jsonb DEFAULT '{}'::jsonb,
  note       text DEFAULT '',
  why        text DEFAULT '',
  source     text DEFAULT '',
  user_id    text DEFAULT '',
  token      text DEFAULT '',
  status     text DEFAULT 'pending',   -- pending | done | rejected | failed | expired
  result     text DEFAULT '',
  created_at double precision
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

-- 📄 エージェント成果物（Artifacts）— create_document / create_spreadsheet の保存先。
-- content は Markdown / CSV などの小さめテキスト。Aibou内でダウンロードできる。
CREATE TABLE IF NOT EXISTS artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text DEFAULT 'document',   -- document | spreadsheet | image
  title      text NOT NULL,
  content    text DEFAULT '',
  mime       text DEFAULT 'text/markdown',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);

-- 📧 ニュースレター購読者（ダブルオプトイン）
-- status: pending（確認待ち・配信しない）| confirmed（配信対象）| unsubscribed
CREATE TABLE IF NOT EXISTS subscribers (
  email      text PRIMARY KEY,
  status     text DEFAULT 'pending',
  source     text DEFAULT '',
  token      text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscribers_token ON subscribers(token);

-- 📧 ニュースレター配信号（下書き→承認→送信）
CREATE TABLE IF NOT EXISTS newsletter_issues (
  id         text PRIMARY KEY,
  subject    text NOT NULL,
  body       text DEFAULT '',
  status     text DEFAULT 'draft',
  sent_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 🔎 Programmatic SEO（掛け合わせキーワードの大量ページ）
-- status: draft（生成直後・非公開）| approved（公開）| rejected
-- 承認したページだけが /pseo/public と sitemap に出る（セミオート原則）。
CREATE TABLE IF NOT EXISTS pseo_pages (
  slug       text PRIMARY KEY,
  title      text NOT NULL,
  keywords   text DEFAULT '',
  content    jsonb DEFAULT '{}'::jsonb,
  status     text DEFAULT 'draft',
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pseo_status ON pseo_pages(status, updated_at DESC);

-- 💓 停止防止（Keep-Alive）— 無料枠Supabaseは7日間アクセスが無いと一時停止する。
-- 定期的に id=1 の1行を upsert して「活動あり」と認識させる。
CREATE TABLE IF NOT EXISTS keepalive (
  id        int PRIMARY KEY,
  last_ping text DEFAULT ''
);

-- ⏰ 定期実行（Scheduler）— 毎日 or 曜日指定の時刻にエージェント指示を自動実行。
CREATE TABLE IF NOT EXISTS schedules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction text NOT NULL,
  time       text DEFAULT '08:00',      -- HH:MM (JST)
  days       text DEFAULT 'daily',      -- 'daily' | 'mon,wed,fri' 形式
  enabled    boolean DEFAULT true,
  last_run   text DEFAULT '',           -- YYYY-MM-DD
  created_at timestamptz DEFAULT now()
);
-- 既存テーブルへの後方互換アップグレード（自動マイグレーションで反映）
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS days text DEFAULT 'daily';
-- BOARDの自動化を時刻で回すための参照（空ならエージェントへの指示として実行）
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS automation_id text DEFAULT '';

-- 🤗 HF MODELS — HuggingFaceのモデル台帳。タスク（text/image/asr/…）ごとに登録し、
-- アプリの役割（会話/コード/画像/文字起こし）へ割り当てて使う。
-- verified は「実際に1回叩いて動いた」かどうか。動作未確認と区別するために持つ。
CREATE TABLE IF NOT EXISTS hf_models (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model      text NOT NULL,               -- 例: openai/whisper-large-v3
  task       text NOT NULL,               -- text | image | asr | translate | …
  label      text DEFAULT '',
  note       text DEFAULT '',
  verified   boolean DEFAULT false,
  last_error text DEFAULT '',
  checked_at text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hf_models_task ON hf_models(task, created_at DESC);

-- 🖼 HFで生成した画像。バイト列をbase64で持ち、/hf/image/{id} で配る。
-- data: URLを履歴に入れると一覧が数MBになるため、URLで配れるようここに置く。
CREATE TABLE IF NOT EXISTS hf_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime       text DEFAULT 'image/png',
  data       text NOT NULL,               -- base64
  prompt     text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- 👤 利用者ごとの「自分のSupabase」接続台帳。
-- これは管理者のプロジェクト側にだけ置く（各利用者のDBには作られない）。
-- service_key / db_url は Fernet で暗号化した文字列のみを保存する。
CREATE TABLE IF NOT EXISTS user_connections (
  user_id     text PRIMARY KEY,          -- Supabase Auth の sub
  url         text NOT NULL,             -- https://xxxx.supabase.co
  service_key text NOT NULL,             -- enc:v1:…（復号はサーバー内部のみ）
  db_url      text DEFAULT '',           -- enc:v1:…（テーブル自動作成に使う）
  label       text DEFAULT '',
  verified_at text DEFAULT '',
  created_at  timestamptz DEFAULT now()
);
