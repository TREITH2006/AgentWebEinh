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

/**
 * Origin every browser-visible API path is mapped onto.
 *
 * The trailing slash is stripped here rather than at each destination: the public
 * target carries a path prefix (`https://<host>/agentwebeinh`), so a target
 * written with a trailing slash would emit `.../agentwebeinh//api/tasks`. The
 * prefix belongs to the target alone and is never appended here, so it can be
 * duplicated or dropped by neither the REST nor the WebSocket rule.
 */
function proxyTarget(): string {
  return (process.env.NEXT_PUBLIC_API_PROXY_TARGET ?? DEFAULT_PROXY_TARGET).replace(/\/+$/, "");
}

/**
 * True on Vercel, where a WebSocket upgrade cannot be forwarded by a rewrite.
 *
 * Vercel terminates the handshake at the edge and hands the request to the
 * function, and only `experimental_upgradeWebSocket()` can switch protocols from
 * there — `src/app/ws/backend/[...path]/route.ts` does that. A rewrite would
 * shadow that route and proxy the request through fetch instead, which never
 * completes the handshake. Off Vercel, Next's own server *does* forward upgrades
 * through a rewrite, so the route is skipped and local `next dev` keeps its
 * native socket through the same browser-visible path.
 *
 * `rewrites()` is evaluated during `next build` and the result is baked into the
 * routes manifest, so a build-time constant is sufficient: `VERCEL` is present in
 * the Vercel build environment. For the same reason `NEXT_PUBLIC_API_PROXY_TARGET`
 * must be set on the project *and* available to the build — a production
 * deployment built without it falls back to `DEFAULT_PROXY_TARGET`, which is this
 * machine's loopback address and therefore unreachable from Vercel.
 */
function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The frontend talks to the AgentWebEinh backend only. This proxy is the single
  // place where a browser-visible path is mapped onto the backend origin, so CORS
  // and cookie handling stay in one place when the API is integrated.
  //
  // `beforeFiles`, so `/api/backend` is an alias of the backend rather than a
  // route that could shadow one.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/backend/:path*",
          destination: `${proxyTarget()}/:path*`,
        },
        // Off Vercel only; see isVercelRuntime(). The target is identical to the
        // REST one on purpose: a REST/WS split here is a silent failure, because
        // the UI connects while the stream does not.
        ...(isVercelRuntime()
          ? []
          : [
              {
                source: "/ws/backend/:path*",
                destination: `${proxyTarget()}/:path*`,
              },
            ]),
      ],
    };
  },
};

export default nextConfig;