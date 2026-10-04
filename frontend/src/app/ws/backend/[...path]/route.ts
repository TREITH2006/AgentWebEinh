/* =============================================================================
   WebSocket proxy — `/ws/backend/*`
   -----------------------------------------------------------------------------
   Browser -> this route -> Tailscale Funnel -> FastAPI.

   `apiWsUrl()` in `src/lib/config.ts` re-roots the backend's stream path onto
   `/ws/backend`, so the browser never learns the backend's public host and the
   proxy stays the single mapping point. This route re-roots it once more, onto
   `NEXT_PUBLIC_API_PROXY_TARGET`, and relays frames in both directions.

   Why a route handler and not the rewrite that shares its prefix: Vercel
   terminates the handshake at the edge and hands the request to the function,
   where only `experimental_upgradeWebSocket()` can complete the protocol switch.
   A rewrite is applied by fetch, which cannot. `next.config.ts` therefore omits
   the `/ws/backend` rewrite when `VERCEL` is set, and keeps it everywhere else,
   where Next's own server forwards upgrades natively and this route is skipped.

   The relay is deliberately transparent. Frames, ordering and the close code
   reach the browser untouched, so `TaskEventStream` cannot tell the difference
   between a socket proxied here and one opened against the backend directly —
   including `1000` on a settled task and `4404` on an unknown one.
   ============================================================================= */

import { connection } from "next/server";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";

/**
 * Node only: the upgrade needs a real socket, and `ws` is a native dependency.
 * `force-dynamic` plus `connection()` keep the route out of prerendering, so the
 * upgrade runs per request instead of being frozen into a build artifact.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Longest single stream a task can hold open, in seconds. Tasks self-close at a
 *  terminal status well before this, and the client reconnects when it does not. */
export const maxDuration = 300;

/** A task's own `step_timeout_seconds` leaves plenty of room; this only bounds a
 *  half-open TCP connection to a backend that has gone away. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Frames are JSON task snapshots and events; anything this size is not one. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Mirrors `DEFAULT_PROXY_TARGET` in `next.config.ts`.
 *
 * Duplicated rather than shared because `next.config.ts` is evaluated by Next's
 * own build-time loader and cannot import from `src/`. The two must name the same
 * origin: a REST/WS split is invisible until the stream stops updating.
 */
function proxyTarget(): string {
  const target = process.env.NEXT_PUBLIC_API_PROXY_TARGET ?? "http://127.0.0.1:8001";
  return target.replace(/\/+$/, "");
}

/** `http(s)` -> `ws(s)`, so one variable configures both transports. */
function backendSocketOrigin(target: string): string {
  return target.replace(/^http/i, "ws");
}

/**
 * Close codes that may legally travel on the wire.
 *
 * 1004/1005/1006 are reserved for the protocol and must never be sent, and a code
 * outside these ranges would throw inside `ws` and leave the browser's socket open
 * with no explanation — the one outcome that stops the client from falling back to
 * polling. Unusable codes collapse to 1011.
 */
function forwardableCloseCode(code: number): number {
  if (code === 1000) return code;
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1001 && code <= 1015 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  return 1011;
}

/** RFC 6455 caps a close reason at 123 bytes; longer ones would throw on send. */
function closeReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason : Buffer.from(reason as Buffer).toString("utf8");
  return text.length > 120 ? text.slice(0, 120) : text;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  await connection();

  // Each segment is re-encoded: the backend validates a prefixed ULID and answers
  // 422 for anything else, but re-encoding here also means a crafted `..` cannot
  // walk out of the task's own path segment before the request is ever forwarded.
  const { path = [] } = await context.params;
  const suffix = path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const query = new URL(request.url).search;
  const upstreamUrl = `${backendSocketOrigin(proxyTarget())}${suffix}${query}`;

  return experimental_upgradeWebSocket(
    (browser) => {
      const backend = new WebSocket(upstreamUrl, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });

      // An `error` with no listener is re-thrown by EventEmitter, so both sockets
      // get one. Failure is reported by closing: `TaskEventStream` only falls back
      // to polling once the connection ends, and a socket left open saying nothing
      // would hold the UI on a stream that is never coming.
      browser.on("error", () => {});

      backend.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (browser.readyState !== WebSocket.OPEN) return;
        browser.send(isBinary ? data : data.toString(), { binary: isBinary });
      });

      // Nothing in the protocol travels client -> backend today. Relaying anyway
      // keeps this route a proxy rather than a subscriber, so the client can be
      // changed to send without touching the deployment.
      browser.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (backend.readyState !== WebSocket.OPEN) return;
        backend.send(isBinary ? data : data.toString(), { binary: isBinary });
      });

      backend.on("close", (code, reason) => {
        if (browser.readyState !== WebSocket.OPEN) return;
        browser.close(forwardableCloseCode(code), closeReason(reason));
      });

      backend.on("error", () => {
        if (browser.readyState === WebSocket.OPEN) browser.close(1011, "backend unreachable");
      });

      // Closing either end closes the other, so a browser that navigates away does
      // not leave a subscription running on the task manager.
      browser.on("close", () => {
        if (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING) {
          backend.close();
        }
      });
    },
    { maxPayload: MAX_PAYLOAD_BYTES },
  );
}