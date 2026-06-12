-- =====================================================================
-- AIbou — 長期記憶テーブル（agent_memory）
-- 適用先：本体プロジェクト、または記憶専用の「別プロジェクト」のどちらでも可。
--   * 本体に適用     → アプリ(anon+JWT)から RLS で自分の記憶のみ読み書き。
--   * 別プロジェクト → memory 用の service role キーで運用（RLSはバイパスされ、
--                      アプリが user_id で絞り込む）。MEMORY_SUPABASE_URL/KEY を設定。
-- =====================================================================
create table if not exists public.agent_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  role       text,                 -- 'user' | 'assistant' | 'fact'
  content    text,
  importance int default 0,        -- >=1 は優先想起（remember で登録した事実）
  created_at timestamptz default now()
);
create index if not exists idx_agent_memory_user on public.agent_memory(user_id, created_at desc);

alter table public.agent_memory enable row level security;
drop policy if exists "agent_memory self" on public.agent_memory;
create policy "agent_memory self" on public.agent_memory
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
