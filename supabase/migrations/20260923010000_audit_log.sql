-- =====================================================================
-- AIbou — 操作の記録（api/audit.py）
-- =====================================================================
--
-- AIbou があなたの代わりに「外で」したこと（メール・予定・手元のファイル・
-- あなたとして押したブラウザ・保存した手順）を、1件1行で残す。
-- 身に覚えのない送信があったときに、AIbou がやったのか、確認して押したのか、
-- 確認なしで動いたのかを辿るため。
--
-- **本文は入らない。** 宛先・URL・パス・手順の名前だけ。鍵らしい物は
-- 書く前に伏せる。
--
-- user_id の列は無い（利用者ごとに自分のDBを持つ作り）。RLSを入れて
-- ポリシーは作らない——anon キーからは1行も見えない。
-- =====================================================================

create table if not exists public.audit_log (
  id          text primary key,
  at          double precision,
  source      text default '',      -- chat / agent / approve / push / schedule / command
  instruction text default '',      -- 頼まれた言葉（200字まで・鍵は伏せる）
  tool        text not null,
  target      text default '',      -- 宛先・URL・パス・手順の名前（本文は入れない）
  "where"     text default '',      -- 手元の台・ブラウザ
  level       integer default 0,
  approved    boolean default false, -- 人が確認カードを見て押したか
  ok          boolean default true,
  summary     text default ''
);

create index if not exists idx_audit_log_at on public.audit_log(at desc);

alter table public.audit_log enable row level security;
