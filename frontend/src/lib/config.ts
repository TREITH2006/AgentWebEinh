/* =============================================================================
   Runtime configuration
   Read once, at module load, from NEXT_PUBLIC_* environment variables.
   Copy `.env.example` to `.env.local` to point the frontend at a real backend.
   ============================================================================= */

export type ApiMode = "auto" | "live" | "demo";

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

const rawMode = readEnv("NEXT_PUBLIC_API_MODE");
const parsedMode: ApiMode =
  rawMode === "live" || rawMode === "demo" || rawMode === "auto" ? rawMode : "auto";

/**
 * Base URL for every REST call.
 * Empty string  -> same-origin, routed through the Next.js rewrite in
 *                  next.config.ts to NEXT_PUBLIC_API_PROXY_TARGET. Recommended,
 *                  because it avoids CORS entirely.
 * Absolute URL  -> the browser calls the backend directly; the backend must then
 *                  send permissive CORS headers.
 */
const baseUrl = (readEnv("NEXT_PUBLIC_API_BASE_URL") ?? "").replace(/\/+$/, "");

/**
 * WebSocket base URL. Empty string derives it from the page origin:
 * http -> ws, https -> wss. Set NEXT_PUBLIC_WS_URL when the stream lives on a
 * different host than the REST API.
 */
const wsUrl = (readEnv("NEXT_PUBLIC_WS_URL") ?? "").replace(/\/+$/, "");

export const API_CONFIG = {
  mode: parsedMode,
  baseUrl,
  wsUrl,
  /** Hard timeout for REST calls, ms. */
  timeoutMs: Number(readEnv("NEXT_PUBLIC_API_TIMEOUT_MS") ?? 20_000),
  /** Timeout for the availability probe that decides live vs demo, ms. */
  probeTimeoutMs: Number(readEnv("NEXT_PUBLIC_API_PROBE_TIMEOUT_MS") ?? 2_500),
  /** How often to re-check task status when the stream is unavailable, ms. */
  pollIntervalMs: Number(readEnv("NEXT_PUBLIC_POLL_INTERVAL_MS") ?? 2_500),
  /** Max characters accepted in the task composer. */
  maxPromptLength: Number(readEnv("NEXT_PUBLIC_MAX_PROMPT_LENGTH") ?? 2_000),
  /** Default page size for task history. */
  historyPageSize: Number(readEnv("NEXT_PUBLIC_HISTORY_PAGE_SIZE") ?? 25),
} as const;

/** Prefix applied to every REST path. Empty means "use the proxy path". */
export function apiUrl(path: string): string {
  if (API_CONFIG.baseUrl) return `${API_CONFIG.baseUrl}${path}`;
  return `/api/backend${path}`;
}

/**
 * Absolute ws(s) URL for the live task stream.
 *
 * When NEXT_PUBLIC_WS_URL is set, the path is appended unchanged: that variable
 * points straight at the backend, which owns its own route layout.
 *
 * When it is not set, the stream is proxied through this app exactly like REST,
 * so the path is re-rooted onto the `/ws/backend` prefix declared in
 * next.config.ts. Without this the browser would request `/api/tasks/:id/ws`,
 * which matches no rewrite and 404s at the Next.js server.
 */
export function apiWsUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (API_CONFIG.wsUrl) return `${API_CONFIG.wsUrl}${suffix}`;
  const scheme = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:3000";
  return `${scheme}//${host}${WS_PROXY_PREFIX}${suffix}`;
}

/** Must stay in sync with the `/ws/backend` rewrite in next.config.ts. */
export const WS_PROXY_PREFIX = "/ws/backend";

export const IS_STATIC_EXPORT = API_CONFIG.mode === "demo";