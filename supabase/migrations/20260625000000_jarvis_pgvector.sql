-- =====================================================================
-- JARVIS最終形：セマンティック記憶(pgvector) ＋ 成果物ストレージ
-- Supabase SQL Editor で実行（既存の supabase_schema.sql 実行後）。
-- すべて IF NOT EXISTS / 追加のみで、再実行・既存データに安全。
-- =====================================================================

-- 1) pgvector 拡張（意味検索による“本当に覚えてる”記憶）
create extension if not exists vector;

-- agent_memory に埋め込み列を追加（Gemini text-embedding-004 = 768次元）
alter table public.agent_memory add column if not exists embedding vector(768);

-- 近傍探索インデックス（cosine）
create index if not exists idx_agent_memory_embedding
  on public.agent_memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 類似記憶を取り出すRPC（バックエンドから supabase.rpc("match_memories", {...}) で呼ぶ）
create or replace function public.match_memories(
  query_embedding vector(768),
  match_count int default 8,
  p_user_id text default 'local'
)
returns table (id uuid, role text, content text, importance int, similarity float)
language sql stable as $$
  select m.id, m.role, m.content, m.importance,
         1 - (m.embedding <=> query_embedding) as similarity
  from public.agent_memory m
  where m.embedding is not null
    and (m.user_id = p_user_id or m.user_id is null)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- 2) 成果物ストレージ（生成アプリ/画像/動画/資料を永続・CDN配信）
-- Streamlit Cloud のディスクは揮発するため、生成物は Storage に置く。
insert into storage.buckets (id, name, public)
values ('forge-assets', 'forge-assets', true)
on conflict (id) do nothing;

-- 公開読み取り（個人利用想定。マルチユーザー化時は user_id プレフィックスでRLSを絞る）
drop policy if exists "forge-assets public read" on storage.objects;
create policy "forge-assets public read" on storage.objects
  for select using (bucket_id = 'forge-assets');

-- 書き込みは service role（バックエンドAPI）から行う想定（service role はRLSをバイパス）。
