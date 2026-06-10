# Supabase 連携手順（お手元のPCで実行）

このディレクトリはGitにコミット済みです。実際の `link` / `db pull` / `db push` は
**あなたのPC**（Supabase CLI とプロジェクトのパスワード/アクセストークンがある環境）で実行します。
※ クラウド実行環境にはSupabase CLI・DBパスワードが無く、ネットワークも制限されているため、
　このリポジトリ側ではディレクトリの雛形＋初期マイグレーションのみ用意しています。

## 1. ログイン & リンク
```bash
supabase login                      # ブラウザでアクセストークンを発行
supabase link --project-ref hwjmojipsablfevtjzln
```

## 2-A. 新しい（空の）プロジェクトにスキーマを作る場合 → push
```bash
supabase db push                    # supabase/migrations/ を適用してテーブル作成
```

## 2-B. すでにスキーマがあるプロジェクトから取り込む場合 → pull
```bash
supabase db pull
```

## ⚠️ 先ほどの接続エラーについて
`failed to parse ... invalid userinfo` は **パスワードの角括弧 `[ ]`** が原因です。
ドキュメントの `[YOUR-PASSWORD]` は「角括弧ごと」あなたのパスワードに置き換えます。

```bash
# ❌ NG（角括弧が残っている）
supabase db pull --db-url "postgresql://postgres:[PASSWORD]@db.hwjmojipsablfevtjzln.supabase.co:5432/postgres"

# ✅ OK（角括弧を外す。記号を含むパスワードはURLエンコードが必要）
supabase db pull --db-url "postgresql://postgres:PASSWORD@db.hwjmojipsablfevtjzln.supabase.co:5432/postgres"
```
※ `db.<ref>.supabase.co:5432`（直結）がDNSで引けない/IPv4のみの回線では、
　ダッシュボードの **Connection Pooler**（`...pooler.supabase.com`、ユーザー名は `postgres.<ref>`）を使ってください。
　いちばん簡単なのは上記 `supabase link` 後に **`supabase db pull`（--db-url 無し）** を実行する方法です。

## 📦 別Googleアカウントの旧プロジェクトからの「データ」移行
`db pull` / `db push` は **スキーマ（テーブル定義）のみ**で、**データ行は移動しません**。
データも移す場合は、旧プロジェクトで `pg_dump`、新プロジェクトで `psql`/`pg_restore` を別途実行してください。

## 🔐 セキュリティ
- 先のやり取りでDBパスワードが画面に出ています。**Dashboard → Database → Reset database password** で
  パスワードを再発行することを推奨します。
- パスワードはコマンド履歴に残さないよう、可能なら `--db-url` を使わず `supabase link` 経由で扱ってください。
