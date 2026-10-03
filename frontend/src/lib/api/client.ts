/* =============================================================================
   HTTP client
   Thin wrapper over fetch that adds: base URL resolution, timeout, JSON parsing,
   and a normalised ApiError. Components never call fetch directly.
   ============================================================================= */

import { API_CONFIG, apiUrl } from "../config";
import type { ApiErrorBody } from "@/types/api";

/**
 * Why a request failed.
 *
 * `frontend-unavailable` and `backend-unavailable` are deliberately distinct even
 * though both surface as a failed fetch from the browser: every REST call is
 * same-origin through the Next.js rewrite, so a dead request means *this* app's
 * server is gone, while an upstream failure arrives as a real HTTP status.
 */
export type ApiFailureKind =
  | "frontend-unavailable"
  | "backend-unavailable"
  | "wrong-backend"
  | "endpoint-error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly fields: Record<string, string>;
  readonly url: string;
  readonly kind: ApiFailureKind;

  constructor(init: {
    message: string;
    status: number;
    code?: string | null;
    fields?: Record<string, string>;
    url: string;
    kind?: ApiFailureKind;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code ?? null;
    this.fields = init.fields ?? {};
    this.url = init.url;
    this.kind = init.kind ?? defaultKind(init.status);
  }

  /** 404 is special-cased because the UI shows a dedicated "not found" state. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isNetwork(): boolean {
    return this.kind === "frontend-unavailable";
  }

  /** True when the API answered but refused or failed the request itself. */
  get isEndpointError(): boolean {
    return this.kind === "endpoint-error";
  }
}

/**
 * Map an HTTP status onto a failure kind.
 *
 * A 5xx from the rewrite means the proxy could not get a clean answer from the
 * backend, which is a connectivity problem rather than an API contract problem.
 */
function defaultKind(status: number): ApiFailureKind {
  if (status === 0) return "frontend-unavailable";
  if (status >= 500) return "backend-unavailable";
  return "endpoint-error";
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = apiUrl(path);
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function parseErrorBody(raw: string): ApiErrorBody | null {
  try {
    return JSON.parse(raw) as ApiErrorBody;
  } catch {
    return null;
  }
}

function friendlyMessage(status: number, fallback?: string | null): string {
  switch (status) {
    case 0:
      return "This app's server did not answer. It may have stopped or still be starting.";
    case 400:
      return fallback ?? "The request was rejected as invalid.";
    case 401:
      return "The AgentWebEinh API requires no authentication, so a challenge here means this is a different service.";
    case 403:
      return "The service refused this request. If it asks for credentials, it is not the AgentWebEinh API.";
    case 404:
      return fallback ?? "That endpoint does not exist on the service answering at this address.";
    case 409:
      return fallback ?? "The task is already running or has finished.";
    case 422:
      return fallback ?? "The request could not be processed.";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    default:
      if (status >= 500) {
        return fallback ?? "The backend could not be reached through the proxy.";
      }
      return fallback ?? `Request failed (${status}).`;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, timeoutMs = API_CONFIG.timeoutMs, query } = options;
  const url = buildUrl(path, query);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    if (aborted && signal?.aborted) throw cause;
    throw new ApiError({
      message: friendlyMessage(0),
      status: 0,
      url,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const text = await response.text();
  const bodyText = text.length > 0 ? text : null;

  if (!response.ok) {
    const parsed = bodyText ? parseErrorBody(bodyText) : null;
    throw new ApiError({
      message: friendlyMessage(response.status, parsed?.error?.message ?? parsed?.detail),
      status: response.status,
      code: parsed?.error?.code ?? null,
      fields: parsed?.error?.fields ?? {},
      url,
    });
  }

  if (!bodyText) return undefined as T;

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new ApiError({
      message: "The service returned a response that could not be read.",
      status: response.status,
      url,
    });
  }
}