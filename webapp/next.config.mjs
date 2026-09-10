// Default Supabase project (overridable by env). Only the URL is baked in —
// keys always come from env vars (anon key on Vercel, service_role on backend).
const SUPABASE_URL_DEFAULT = "https://hwjmojipsablfevtjzln.supabase.co";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 点検用のサーバーと、テスト用のビルドが同じ .next を奪い合うと、
  // 片方が相手の設定（API_URLなど）で上書きされ、原因の分からない
  // 「未接続」が出る。NEXT_DIST_DIR で出力先を分けられるようにする。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Keep the build resilient on Vercel: lint/type issues shouldn't hard-fail
  // a deploy of the "face" while the backend contract is still evolving.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // 画像の最適化は使わない（next/image をどこでも使っていない。生成画像は
  // 外部URLなので、通すと配信元をいちいち許可する設定が要るだけ）。
  //
  // 使っていないのに口だけ開いていると、そこに見つかった穴をこちらが
  // 背負うことになる。実際 /_next/image には Next 15.5.24 未満に対する
  // 重大な勧告（AVIFの取り扱い）が出ている。使わない口は閉じておく。
  images: {
    unoptimized: true,
  },
  env: {
    // Default to the shared Supabase project unless overridden in Vercel.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || SUPABASE_URL_DEFAULT,
    // Deploy/connection metadata surfaced in Settings → DIAGNOSTICS.
    // Vercel populates VERCEL_* automatically at build time.
    NEXT_PUBLIC_GIT_REPO:
      process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
        ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
        : "kurawork-oss/aibou-ai-app",
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || "",
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || "",
  },
};

export default nextConfig;
