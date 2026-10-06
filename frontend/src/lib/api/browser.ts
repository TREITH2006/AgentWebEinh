/* =============================================================================
   Browser-extension pairing API service
   -----------------------------------------------------------------------------
   Drives the two REST endpoints behind the "Connect a browser" page: mint a
   one-time pairing code for the extension popup, and read the bridge status that
   shows which browsers are currently paired.
   ============================================================================= */

import { request } from "./client";
import { API_ENDPOINTS } from "./endpoints";
import type { BrowserPeerDto, WebSocketUrlDto } from "@/types/api";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pickBool(source: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return false;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (typeof source[key] === "number" && Number.isFinite(source[key] as number)) {
      return source[key] as number;
    }
  }
  return null;
}

export interface PairingDraft {
  code: string;
  expiresAt: string | null;
  ttlSeconds: number | null;
  websocketEndpoint: string | null;
  websocketUrls: WebSocketUrlDto[];
}

export interface BridgeStatus {
  enabled: boolean;
  agentMode: boolean;
  pairing: boolean;
  peers: BrowserPeerDto[];
  websocketEndpoint: string | null;
  websocketUrls: WebSocketUrlDto[];
}

function normalizeSocketUrl(value: unknown): WebSocketUrlDto | null {
  const source = asRecord(value);
  const url = pickString(source, ["url"]);
  if (!url) return null;
  return {
    label: pickString(source, ["label"]) ?? "Backend",
    url,
    note: pickString(source, ["note"]) ?? "",
  };
}

function normalizeSocketUrls(value: unknown): WebSocketUrlDto[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeSocketUrl)
    .filter((entry): entry is WebSocketUrlDto => entry !== null);
}

function normalizePeer(value: unknown): BrowserPeerDto {
  const source = asRecord(value);
  return {
    browserId: pickString(source, ["browser_id", "browserId"]) ?? "unknown",
    name: pickString(source, ["name"]) ?? "Paired browser",
    connectedAt: pickString(source, ["connected_at", "connectedAt"]) ?? "",
    busy: pickBool(source, ["busy"]),
  };
}

/**
 * `POST /api/browser/pairing` — mint a new short-lived, single-use code.
 * Reaching this endpoint at all proves the bridge exists; failures surface as a
 * normal `ApiError`.
 */
export async function mintPairingCode(signal?: AbortSignal): Promise<PairingDraft> {
  const raw = await request<unknown>(API_ENDPOINTS.browserPairing, {
    method: "POST",
    body: {},
    signal,
  });
  const rec = asRecord(raw);
  const code = pickString(rec, ["code"]);
  if (!code) {
    throw new Error("The backend did not return a pairing code.");
  }
  return {
    code,
    expiresAt: pickString(rec, ["expires_at", "expiresAt"]),
    ttlSeconds: pickNumber(rec, ["ttl_seconds", "ttlSeconds"]),
    websocketEndpoint: pickString(rec, ["websocket_endpoint", "websocketEndpoint"]),
    websocketUrls: normalizeSocketUrls(rec.websocket_urls ?? rec.websocketUrls),
  };
}

/**
 * `GET /api/browser/status` — the shape of the bridge, not just its liveness.
 * `enabled` or `agent_mode` being false is legitimate configuration, not an
 * error, so the page explains it instead of treating it as a failure.
 */
export async function fetchBridgeStatus(signal?: AbortSignal): Promise<BridgeStatus> {
  const raw = await request<unknown>(API_ENDPOINTS.browserStatus, { signal });
  const rec = asRecord(raw);
  const rawPeers = Array.isArray(rec.paired) ? (rec.paired as unknown[]) : [];
  const peers = Array.from(
    new Map(rawPeers.map((peer) => [normalizePeer(peer).browserId, normalizePeer(peer)])).values(),
  );
  return {
    enabled: pickBool(rec, ["enabled"]),
    agentMode: pickBool(rec, ["agent_mode", "agentMode"]),
    pairing: pickBool(rec, ["pairing"]),
    peers,
    websocketEndpoint: pickString(rec, ["websocket_endpoint", "websocketEndpoint"]),
    websocketUrls: normalizeSocketUrls(rec.websocket_urls ?? rec.websocketUrls),
  };
}