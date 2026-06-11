-- =====================================================================
-- AIbou — マルチテナント化（Supabase Auth）
--   * profiles（role: owner/user, 課金状態, Stripe, 規約同意）
--   * 最初の登録者を自動で owner に（trigger）
--   * per-user vault（APIキー）＋ 既存テーブルへ user_id + RLS
--   * income_jobs / income_stats は当面オーナー運用（headless自動化）のため変更しない
-- 適用: `supabase db push` もしくは Dashboard → SQL Editor に貼り付け
-- 前提: Authentication → Providers → Email を有効化しておくこと
-- =====================================================================

-- ---------- profiles ----------
create table if not exists public.profiles (
  id                     uuid primary key references auth.users(id) on delete cascade,
  email                  text,
  role                   text        not null default 'user',      -- 'owner' | 'user'
  income_status          text        not null default 'inactive',  -- 'active' | 'inactive'
  stripe_customer_id     text,
  stripe_subscription_id text,
  accepted_terms_at      timestamptz,
  created_at             timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles self select" on public.profiles;
create policy "profiles self select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles self insert" on public.profiles;
create policy "profiles self insert" on public.profiles
  for insert with check (auth.uid() = id);

-- owner判定。SECURITY DEFINER（postgres所有=BYPASSRLS）なのでRLS再帰しない。
create or replace function public.is_owner()
returns boolean
language sql security definer stable
set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'owner');
$$;

-- owner は全 profile を閲覧/管理できる（ユーザー管理画面用）
drop policy if exists "profiles owner all" on public.profiles;
create policy "profiles owner all" on public.profiles
  for all using (public.is_owner()) with check (public.is_owner());

-- 新規ユーザー登録時に profiles を自動作成。owner が未在籍なら最初の登録者を owner に。
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public as $$
declare has_owner boolean;
begin
  select exists(select 1 from public.profiles where role = 'owner') into has_owner;
  insert into public.profiles (id, email, role)
  values (new.id, new.email, case when has_owner then 'user' else 'owner' end)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- per-user vault（APIキーをアカウント毎に暗号化保存） ----------
create table if not exists public.user_vaults (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  encrypted_keys text,
  updated_at     timestamptz default now()
);
alter table public.user_vaults enable row level security;
drop policy if exists "user_vaults self" on public.user_vaults;
create policy "user_vaults self" on public.user_vaults
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- 既存テーブルへ user_id を付与（既存行は null=旧グローバル扱い） ----------
-- 列DEFAULTを auth.uid() にすることで、アプリ(JWT)からの INSERT は user_id を
-- 自動付与でき、income_engine.py 等のアプリコードを変更せずに per-user 化できる。
-- headless(GitHub Actions=service role)は RLS をバイパスし、user_id=null で書く
-- （owner は is_owner() で全件閲覧できるため、夜間生成ジョブも owner からは見える）。
alter table public.vault_notebooks     add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.dashboard_boards    add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.forge_apps          add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.core_versions       add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.evolution_proposals add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.income_jobs         add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;
alter table public.income_stats        add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;

-- ---------- RLS有効化：自分の行のみ（owner は全件） ----------
do $$
declare t text;
begin
  foreach t in array array[
    'vault_notebooks','dashboard_boards','forge_apps','core_versions',
    'evolution_proposals','income_jobs','income_stats'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%1$s self" on public.%1$I;', t);
    execute format(
      'create policy "%1$s self" on public.%1$I for all '
      'using (auth.uid() = user_id or public.is_owner()) '
      'with check (auth.uid() = user_id or public.is_owner());', t);
  end loop;
end $$;

-- 備考: 各プラットフォームへの実配信（YouTube/Shutterstock等）に使う公式キーは
-- 当面オーナー設定を共用するため、per-user な「配信」パイプラインは Phase 2。
-- 本マイグレーションでは「データの分離」と「モードのアクセス制御」を実現する。
