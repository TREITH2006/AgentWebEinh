import type { NextConfig } from "next";

/**
 * Fallback origin for the proxy.
 *
 * 8001, not 8000. Port 8000 is the backend's *documented* default but is commonly
 * taken by other local services, and this project runs on 8001. Hardcoding 8000
 * here meant a missing or absent `.env.local` silently proxied to whatever else
 * was listening there — the failure this proxy exists to make visible.
 */
const DEFAULT_PROXY_TARGET = "http://127.0.0.1:8001";

function proxyTarget(): string {
  return process.env.NEXT_PUBLIC_API_PROXY_TARGET ?? DEFAULT_PROXY_TARGET;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The frontend talks to the AgentWebEinh backend only. This proxy is the single
  // place where a browser-visible path is mapped onto the backend origin, so CORS
  // and cookie handling stay in one place when the API is integrated.
  //
  // Read at request time, not build time, so changing the port in `.env.local`
  // does not require a rebuild.
  async rewrites() {
    return [
      {
        source: "/api/backend/:path*",
        destination: `${proxyTarget()}/:path*`,
      },
      {
        source: "/ws/backend/:path*",
        destination: `${proxyTarget()}/:path*`,
      },
    ];
  },
};

export default nextConfig;