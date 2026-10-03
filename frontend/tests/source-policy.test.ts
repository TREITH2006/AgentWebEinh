/* =============================================================================
   Live / demo source policy
   -----------------------------------------------------------------------------
   The rule under test: a session that says "Live backend" must never render
   synthetic tasks. Demo data is allowed only when the policy explicitly grants
   it, and only for a backend that is genuinely unreachable — not for one that is
   reachable but is not AgentWebEinh.
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { decideSource, DEMO_FALLBACK_SUFFIX } from "../src/lib/api/source-policy";
import type { BackendFailureKind } from "../src/lib/api/status";

const KINDS: readonly BackendFailureKind[] = [
  "frontend-unavailable",
  "backend-unavailable",
  "wrong-backend",
  "endpoint-error",
];

test("a verified backend is live in both live and auto", () => {
  for (const effective of ["live", "auto"] as const) {
    const decision = decideSource(effective, { ok: true });
    assert.equal(decision.status, "live");
    assert.equal(decision.useDemo, false);
    assert.equal(decision.reason, null);
  }
});

test("live mode never substitutes demo data, for any failure", () => {
  for (const kind of KINDS) {
    const decision = decideSource("live", { ok: false, kind, message: `boom: ${kind}` });
    assert.equal(decision.status, "error", `kind ${kind}`);
    assert.equal(decision.useDemo, false, `kind ${kind} must not unlock demo data`);
    assert.equal(decision.reason, `boom: ${kind}`);
  }
});

test("auto falls back to demo only when the backend is unreachable", () => {
  for (const kind of ["frontend-unavailable", "backend-unavailable"] as const) {
    const decision = decideSource("auto", { ok: false, kind, message: "down" });
    assert.equal(decision.status, "demo", `kind ${kind}`);
    assert.equal(decision.useDemo, true, `kind ${kind}`);
    assert.match(decision.reason ?? "", /Showing sample data/);
    assert.ok((decision.reason ?? "").endsWith(DEMO_FALLBACK_SUFFIX));
  }
});

test("auto refuses to mask a wrong service with demo data", () => {
  // A reachable listener that is not AgentWebEinh is a misconfiguration. Falling
  // back to sample data here would hide the exact problem the user must fix.
  const decision = decideSource("auto", { ok: false, kind: "wrong-backend", message: "not us" });
  assert.equal(decision.status, "error");
  assert.equal(decision.useDemo, false);
});

test("forced demo mode needs no probe and still grants demo", () => {
  const decision = decideSource("demo", { ok: true });
  assert.equal(decision.status, "demo");
  assert.equal(decision.useDemo, true);
});

test("demo is granted in exactly the intended cases", () => {
  // Guards the invariant directly: one row per mode, so a future edit that widens
  // the fallback shows up as a failure here rather than as silent sample data.
  const rows: readonly [Parameters<typeof decideSource>[0], Parameters<typeof decideSource>[1], boolean][] = [
    ["live", { ok: true }, false],
    ["live", { ok: false, kind: "backend-unavailable", message: "x" }, false],
    ["live", { ok: false, kind: "wrong-backend", message: "x" }, false],
    ["auto", { ok: true }, false],
    ["auto", { ok: false, kind: "backend-unavailable", message: "x" }, true],
    ["auto", { ok: false, kind: "frontend-unavailable", message: "x" }, true],
    ["auto", { ok: false, kind: "wrong-backend", message: "x" }, false],
    ["demo", { ok: true }, true],
  ];

  for (const [effective, outcome, expected] of rows) {
    const decision = decideSource(effective, outcome);
    assert.equal(
      decision.useDemo,
      expected,
      `${effective} + ${outcome.ok ? "ok" : outcome.kind} -> useDemo`,
    );
    assert.equal(decision.useDemo, decision.status === "demo", "useDemo must track status");
  }
});