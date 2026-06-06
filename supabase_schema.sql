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
