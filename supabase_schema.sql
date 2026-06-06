-- =====================================================================
-- AIbou — Supabase テーブル定義
-- 新しいSupabaseプロジェクトを作ったら、SQL Editor でこのファイルを実行する。
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
