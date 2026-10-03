/* =============================================================================
   Backend identity probe
   -----------------------------------------------------------------------------
   Deciding "is the AgentWebEinh backend there?" cannot be done with a bare 2xx.
   Any unrelated service answers `/health` with 200, and that is exactly how an
   unrelated app on port 8000 got selected as the live backend: live mode came up
   green, then every real endpoint 404'd.

   So identity is established structurally, against `GET /api/status`:

     1. the route must exist          -> 404 means "something else is listening"
     2. it must not demand auth       -> AgentWebEinh has no auth layer
     3. the body must match the schema -> a shape check, not just a status code

   The probe is a pure function of an injected `fetch`, so every branch above is
   testable without a server.
   ============================================================================= */

import { API_ENDPOINTS } from "./endpoints";
import { apiUrl } from "../config";
import type { StatusResponseDto } from "@/types/api";

/**
 * Why the backend could not be used. Each case needs a different message: telling
 * a user "cannot reach the service" when the truth is "you are pointed at a
 * different application" sends them to debug the wrong thing.
 */
export type BackendFailureKind =
  /** The request never completed: this frontend's own server is not serving. */
  | "frontend-unavailable"
  /** The proxy could not reach the backend (refused, timed out, 5xx). */
  | "backend-unavailable"
  /** Something is listening, but it is not AgentWebEinh. */
  | "wrong-backend"
  /** The backend answered, but an ordinary API call failed. */
  | "endpoint-error";

export interface BackendOk {
  ok: true;
  status: StatusResponseDto;
}

export interface BackendFailure {
  ok: false;
  kind: BackendFailureKind;
  /** HTTP status from the probe, or 0 when the request never completed. */
  httpStatus: number;
  /** Short, already-user-facing explanation of this specific failure. */
  message: string;
  /** The URL that failed, for the "what did I point at" detail line. */
  url: string;
}

export type BackendProbeResult = BackendOk | BackendFailure;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const STATUS_URL = apiUrl(API_ENDPOINTS.status);

const VALID_STATUS_VALUES = new Set(["healthy", "degraded", "unhealthy"]);

/**
 * Structural check for the `StatusResponse` document.
 *
 * Deliberately stricter than "has a `status` field": the required keys below are
 * AgentWebEinh's own vocabulary, so a different FastAPI app that happens to
 * expose `/api/status` still fails this test rather than being adopted.
 */
export function isAgentWebEinhStatus(value: unknown): value is StatusResponseDto {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;

  if (typeof doc.status !== "string" || !VALID_STATUS_VALUES.has(doc.status)) return false;
  if (typeof doc.healthy !== "boolean") return false;
  if (typeof doc.version !== "string" || doc.version.length === 0) return false;
  if (typeof doc.environment !== "string") return false;
  if (typeof doc.uptime_seconds !== "number") return false;
  if (typeof doc.public_base_url !== "string") return false;

  const components = doc.components;
  if (typeof components !== "object" || components === null || Array.isArray(components)) {
    return false;
  }
  // Both are AgentWebEinh's own component keys; a generic status document will
  // not have them.
  const names = Object.keys(components as Record<string, unknown>);
  return names.includes("database") && names.includes("task_manager");
}

/** Message per failure kind. Kept here so the wording cannot drift per caller. */
function describe(kind: BackendFailureKind, httpStatus: number, detail?: string): string {
  const suffix = detail ? ` (${detail})` : "";
  switch (kind) {
    case "frontend-unavailable":
      return "This app's own server did not answer. It may have stopped or still be starting.";
    case "backend-unavailable":
      return `The AgentWebEinh backend is not answering${suffix}.`;
    case "wrong-backend":
      return httpStatus === 401 || httpStatus === 403
        ? `The service at this address requires authentication, so it is not the AgentWebEinh API${suffix}.`
        : `Something is listening, but it is not the AgentWebEinh API${suffix}.`;
    case "endpoint-error":
      return `The AgentWebEinh API returned an error${suffix}.`;
  }
}

/**
 * Classify a probe response.
 *
 * Exported so the branches can be tested directly against synthetic responses,
 * including the case this whole module exists for: a 200 that is not us.
 */
export function classifyProbeResponse(
  httpStatus: number,
  payload: unknown,
  url: string,
): BackendProbeResult {
  if (httpStatus === 404) {
    // The backend always implements /api/status. A 404 means the listener is
    // something else entirely.
    return {
      ok: false,
      kind: "wrong-backend",
      httpStatus,
      message: describe("wrong-backend", 404, `no ${API_ENDPOINTS.status} route at ${url}`),
      url,
    };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    // AgentWebEinh has no auth layer, so an auth challenge proves it is not us.
    return {
      ok: false,
      kind: "wrong-backend",
      httpStatus,
      message: describe("wrong-backend", httpStatus),
      url,
    };
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      kind: "backend-unavailable",
      httpStatus,
      message: describe("backend-unavailable", httpStatus, `HTTP ${httpStatus}`),
      url,
    };
  }

  if (!isAgentWebEinhStatus(payload)) {
    // 2xx, but the body is not ours. The dangerous case: a generic liveness check
    // would have stopped here and called this a success.
    return {
      ok: false,
      kind: "wrong-backend",
      httpStatus,
      message: describe("wrong-backend", httpStatus, `HTTP ${httpStatus} did not return an AgentWebEinh status document`),
      url,
    };
  }

  return { ok: true, status: payload };
}

/**
 * Probe `GET /api/status`.
 *
 * Never throws: a probe that rejects cannot be told apart from a failed probe,
 * and the caller needs a message either way.
 */
export async function probeBackend(
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<BackendProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(STATUS_URL, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    // Same-origin request that never completed: this frontend's server is gone,
    // which is a different problem from the backend being down.
    return {
      ok: false,
      kind: "frontend-unavailable",
      httpStatus: 0,
      message: describe("frontend-unavailable", 0),
      url: STATUS_URL,
    };
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON 2xx body is treated below as a wrong identity, not a crash.
    payload = null;
  }

  return classifyProbeResponse(response.status, payload, STATUS_URL);
}

/** Exposed for the data-source layer's messages. */
export { STATUS_URL };