/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the build resilient on Vercel: lint/type issues shouldn't hard-fail
  // a deploy of the "face" while the backend contract is still evolving.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
