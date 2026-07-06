// Default Supabase project (overridable by env). Only the URL is baked in —
// keys always come from env vars (anon key on Vercel, service_role on backend).
const SUPABASE_URL_DEFAULT = "https://hwjmojipsablfevtjzln.supabase.co";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the build resilient on Vercel: lint/type issues shouldn't hard-fail
  // a deploy of the "face" while the backend contract is still evolving.
  eslint: {
    ignoreDuringBuilds: true,
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
