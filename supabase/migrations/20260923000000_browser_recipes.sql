-- =====================================================================
-- AIbou — 決まった手順（ブラウザ）を残す表（api/recipes.py）
-- =====================================================================
--
-- 一度うまくいった手順に名前を付けて残し、次からはその通りに流す。
-- 手元の相棒の専用ブラウザ（Playwright）で流す。
--
-- **パスワードはここに入らない。** 入力欄の名前がパスワード・暗証番号・
-- 認証コードらしい手順や、鍵らしい文字列は、保存する前にサーバーが断る
-- （api/recipes.py の clean_steps）。ログインは本人が手元で一度だけ通す。
--
-- user_id の列は無い（利用者ごとに自分のDBを持つ作り）。RLSを入れて
-- ポリシーは作らない——anon キーからは1行も見えない。サーバーは
-- service_role で動くので、アプリの動きは変わらない（rls_everywhere と同じ）。
-- =====================================================================

create table if not exists public.browser_recipes (
  id          text primary key,
  name        text not null,
  description text default '',
  url         text not null,
  steps       jsonb default '[]'::jsonb,   -- [{do, target, value}]
  params      jsonb default '[]'::jsonb,   -- 空け所の名前（{顧客名} など）
  device      text default '',             -- 決まった台で流すとき、その名前
  created_at  double precision,
  updated_at  double precision,
  last_run_at double precision,
  last_result text default ''
);

create index if not exists idx_browser_recipes_updated
  on public.browser_recipes(updated_at desc);

alter table public.browser_recipes enable row level security;
