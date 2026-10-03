/* =============================================================================
   Live / demo source policy
   -----------------------------------------------------------------------------
   The rule that decides what the app is allowed to show after a probe. It lives
   on its own, away from React, because this is the part that must not regress:

   the failure that motivated it was a live session that reported itself as
   connected while every request 404'd, because a bare 200 from an unrelated
   service on the configured port was accepted as proof of identity.

   Invariant, enforced by returning `useDemo` and nothing else: **sample data is
   created if and only if `useDemo` is true.** No other code path may reach the
   demo service.
   ============================================================================= */

import type { ApiMode } from "../config";
import type { BackendFailureKind } from "./status";

export type SourceStatus = "checking" | "live" | "demo" | "error";

export interface SourceDecision {
  /** Resolved state, never "checking": that is the pre-probe state. */
  status: Exclude<SourceStatus, "checking">;
  /** Whether demo content may be created. The only gate on the demo service. */
  useDemo: boolean;
  /** User-facing explanation when not live. */
  reason: string | null;
}

export const DEMO_FALLBACK_SUFFIX =
  "Showing sample data so the interface stays usable.";

export type ProbeOutcome =
  | { ok: true }
  | { ok: false; kind: BackendFailureKind; message: string };

/**
 * Decide what to do with a probe result.
 *
 * `live` is honoured literally: if the operator asked for the live backend and it
 * cannot be verified, the app reports that. It does not fall back, because a
 * "Live backend" session rendering synthetic tasks is a false report about the
 * system's behaviour.
 *
 * `auto` keeps its documented promise — use the backend when it works, sample
 * data otherwise — but distinguishes *unreachable* from *not us*. A wrong service
 * is reachable and unusable, which is a misconfiguration to surface rather than a
 * gap to paper over with sample data.
 */
export function decideSource(effective: ApiMode, outcome: ProbeOutcome): SourceDecision {
  if (effective === "demo") {
    return {
      status: "demo",
      useDemo: true,
      reason: "Demo mode forced by NEXT_PUBLIC_API_MODE.",
    };
  }

  if (outcome.ok) {
    return { status: "live", useDemo: false, reason: null };
  }

  if (effective === "live") {
    return { status: "error", useDemo: false, reason: outcome.message };
  }

  // effective === "auto"
  if (outcome.kind === "wrong-backend") {
    return { status: "error", useDemo: false, reason: outcome.message };
  }

  return {
    status: "demo",
    useDemo: true,
    reason: `${outcome.message} ${DEMO_FALLBACK_SUFFIX}`,
  };
}