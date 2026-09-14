-- =====================================================================
-- AIbou — どの表も、ブラウザから素通りで読めないようにする（仕様§14）
-- =====================================================================
--
-- なぜ要るか
-- ----------
-- ログインに Supabase Auth を使う構成にすると、**anon キーがブラウザの
-- JSに入る**。そういう鍵なのでそれ自体は正しいが、Supabase は PostgREST を
-- 通してその鍵で表を直接叩ける。止めるのは RLS だけ。
--
-- 実測（この migration を書いた時点）:
--
--     supabase_schema.sql が作る表  35
--     RLSが入っていた表              4   ← agent_memory ほか
--     素通りで読めた表              31   ← api_keys・conversations・
--                                          tasks・inbox_messages …
--
-- `api_keys` の中身は暗号化してあるが、それ以外（会話・タスク・受信箱・
-- 覚えていること・受信した通知）は素のまま入っている。
--
-- 何をするか
-- ----------
--   ・user_id のある表 … 自分の行だけ（auth.uid() = user_id）
--   ・user_id の無い表 … **ポリシーを作らない**
--
-- RLSを入れてポリシーが無ければ、anon からは1行も見えない。
-- サーバー側（FastAPI）は service_role で動いていて RLS を通らないので、
-- **アプリの動きは何も変わらない**。ブラウザは supabase.auth.* しか
-- 呼んでいない（表は1つも触っていない）ことを確かめた上でこうしている。
--
-- 既にポリシーがある表は、そのまま残す
-- ------------------------------------
-- multitenant の migration が `auth.uid() = user_id or public.is_owner()`
-- を入れている表がある。ここで作り直すと、**持ち主が自分の管理画面から
-- 見られなくなる**。既にポリシーがある表には触らない。
--
-- 何度流しても同じ
-- ----------------
-- 表が無ければ飛ばす。配り方によって表の顔ぶれが違うので、
-- 「無いからエラー」で全部止まるほうが困る。
-- =====================================================================

do $$
declare
  t           text;
  has_user    boolean;
  has_policy  boolean;
  owner_fn    boolean;
begin
  -- 持ち主判定の関数があるか（multitenant を流していない構成もある）
  select exists(
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_owner'
  ) into owner_fn;

  foreach t in array array[
    'agent_memory','agent_rules','api_keys','approvals','artifacts',
    'automations','conversations','core_versions','dashboard_boards',
    'events','evolution_proposals','forge_apps','hf_images','hf_models',
    'hooks','inbox_messages','income_jobs','income_stats','keepalive',
    'life_entries','missions','newsletter_issues','notifications',
    'profiles','pseo_pages','push_subscriptions','schedules',
    'setup_sessions','studio_ais','studio_workflows','subscribers',
    'tasks','user_connections','user_vaults','vault_data',
    'vault_notebooks','watch_state'
  ]
  loop
    -- その表が無い配り方もある。無ければ飛ばす。
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      continue;
    end if;

    execute format('alter table public.%I enable row level security;', t);

    -- 既にポリシーがあるなら触らない（上のコメント参照）
    select exists(
      select 1 from pg_policies where schemaname = 'public' and tablename = t
    ) into has_policy;
    if has_policy then
      continue;
    end if;

    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'user_id'
    ) into has_user;

    if has_user then
      if owner_fn then
        execute format(
          'create policy "%1$s self" on public.%1$I for all '
          'using (auth.uid() = user_id or public.is_owner()) '
          'with check (auth.uid() = user_id or public.is_owner());', t);
      else
        execute format(
          'create policy "%1$s self" on public.%1$I for all '
          'using (auth.uid() = user_id) '
          'with check (auth.uid() = user_id);', t);
      end if;
    end if;
    -- user_id が無い表には、わざとポリシーを作らない。
    -- RLSだけ入れておけば anon からは1行も見えず、サーバー
    -- （service_role）からは今まで通り読める。
  end loop;
end $$;
