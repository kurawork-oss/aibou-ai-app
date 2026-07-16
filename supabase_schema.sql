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

-- 【Phase 2】Dashboard（Miroボード）の永続化
CREATE TABLE IF NOT EXISTS dashboard_boards (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nodes      jsonb DEFAULT '[]'::jsonb,
  edges      jsonb DEFAULT '[]'::jsonb,
  updated_at timestamp DEFAULT now()
);

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

-- ⏰ 定期実行（Scheduler）— 毎日 指定時刻にエージェント指示を自動実行。
CREATE TABLE IF NOT EXISTS schedules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction text NOT NULL,
  time       text DEFAULT '08:00',      -- HH:MM (JST)
  enabled    boolean DEFAULT true,
  last_run   text DEFAULT '',           -- YYYY-MM-DD
  created_at timestamptz DEFAULT now()
);
