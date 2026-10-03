import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The frontend talks to the AgentWebEinh backend only. This proxy is the single
  // place where a browser-visible path is mapped onto the backend origin, so CORS
  // and cookie handling stay in one place when the API is integrated.
  async rewrites() {
    return [
      {
        source: "/api/backend/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_PROXY_TARGET ?? "http://127.0.0.1:8000"}/:path*`,
      },
      {
        source: "/ws/backend/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_PROXY_TARGET ?? "http://127.0.0.1:8000"}/:path*`,
      },
    ];
  },
};

export default nextConfig;