/* =============================================================================
   Backend identity
   -----------------------------------------------------------------------------
   These tests exist because of a concrete failure: the app was pointed at a port
   owned by an unrelated service. That service answered `/health` with
   `200 {"status":"healthy"}`, so the app reported "connected to backend" and then
   404'd on every real endpoint.

   The first test below is the regression test for exactly that.
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyProbeResponse,
  isAgentWebEinhStatus,
  probeBackend,
  type FetchLike,
} from "../src/lib/api/status";

/** The document AgentWebEinh actually returns from GET /api/status. */
const AGENTWEB_STATUS = {
  status: "healthy",
  healthy: true,
  version: "1.0.0",
  environment: "development",
  server_time: "2026-10-03T12:00:00Z",
  uptime_seconds: 42.5,
  public_base_url: "http://127.0.0.1:8001",
  components: {
    database: { state: "ready", detail: null, latency_ms: 1 },
    task_manager: { state: "ready", detail: null, latency_ms: null },
  },
  ollama: { available: false },
  openclaw: { available: false },
  browser: { available: true },
  tinyfish: { available: false },
  notes: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("rejects an unrelated service that answers 200 on /health", () => {
  // The exact shape the wrong service returned. A liveness check accepts it.
  const wrongService = { status: "healthy" };
  assert.equal(isAgentWebEinhStatus(wrongService), false);

  const result = classifyProbeResponse(200, wrongService, "http://127.0.0.1:8000/api/status");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "wrong-backend");
  assert.match(result.ok === false ? result.message : "", /not the AgentWebEinh API/);
});

test("rejects a 200 whose status document is structurally wrong", () => {
  const missingComponents = { ...AGENTWEB_STATUS, components: undefined };
  assert.equal(isAgentWebEinhStatus(missingComponents), false);

  // Another FastAPI app can expose /api/status; our own component keys are the
  // discriminator, so a generic component map is not enough.
  const foreignComponents = { ...AGENTWEB_STATUS, components: { database: {}, redis: {} } };
  assert.equal(isAgentWebEinhStatus(foreignComponents), false);

  const result = classifyProbeResponse(200, foreignComponents, "http://127.0.0.1:8001/api/status");
  assert.equal(result.ok === false && result.kind, "wrong-backend");
});

test("accepts the real backend status document", () => {
  assert.equal(isAgentWebEinhStatus(AGENTWEB_STATUS), true);
  const result = classifyProbeResponse(200, AGENTWEB_STATUS, "http://127.0.0.1:8001/api/status");
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.status.version, "1.0.0");
});

test("accepts a degraded but correctly-identified backend", () => {
  // Identity and health are different questions. A degraded AgentWebEinh is still
  // AgentWebEinh, and treating it as a stranger would be its own bug.
  const degraded = { ...AGENTWEB_STATUS, status: "degraded", healthy: false };
  assert.equal(isAgentWebEinhStatus(degraded), true);
  assert.equal(classifyProbeResponse(200, degraded, "u").ok, true);
});

test("classifies each failure mode distinctly", () => {
  const cases: readonly [number, unknown, string][] = [
    [404, { detail: "Not Found" }, "wrong-backend"],
    [401, { detail: "Unauthorized" }, "wrong-backend"],
    [403, { detail: "Forbidden" }, "wrong-backend"],
    // Gateway-generated statuses name the proxy, not the backend. Collapsing them
    // into "backend unavailable" points the operator at the wrong process.
    [502, "Bad Gateway", "proxy-error"],
    [503, "Service Unavailable", "proxy-error"],
    [504, "Gateway Timeout", "proxy-error"],
    [500, "Internal Server Error", "backend-unavailable"],
  ];

  for (const [status, body, expected] of cases) {
    const result = classifyProbeResponse(status, body, "http://127.0.0.1:8001/api/status");
    assert.equal(result.ok, false, `HTTP ${status} must not be accepted`);
    assert.equal(result.ok === false && result.kind, expected, `HTTP ${status}`);
  }
});

test("reports a slow backend as a timeout, not as a dead frontend", () => {
  // The regression this guards: the probe deadline elapsed against a perfectly
  // healthy backend, and the abort was reported as "this app's server did not
  // answer" — sending the operator to restart a Next.js server that was fine.
  const stalled: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });

  return probeBackend(stalled, 20).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "timeout");
    assert.match(result.ok === false ? result.message : "", /deadline/i);
    assert.doesNotMatch(result.ok === false ? result.message : "", /own server/i);
  });
});

test("reports a dead frontend separately from a dead backend", () => {
  // Every REST call is same-origin through the Next.js rewrite, so a request that
  // never completes means *this app's* server is gone — a different fix from
  // "the backend on 8001 is not running".
  const refused: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
  return probeBackend(refused, 500).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "frontend-unavailable");
    assert.equal(result.ok === false && result.httpStatus, 0);
  });
});

test("probes /api/status, not /health", async () => {
  let requested = "";
  const spy: FetchLike = (input) => {
    requested = input;
    return Promise.resolve(jsonResponse(200, AGENTWEB_STATUS));
  };

  const result = await probeBackend(spy, 500);
  assert.equal(result.ok, true);
  assert.match(requested, /\/api\/status$/);
  assert.doesNotMatch(requested, /\/health$/);
});

test("treats a non-JSON 200 as the wrong service", async () => {
  const html200: FetchLike = () =>
    Promise.resolve(new Response("<html>hello</html>", { status: 200 }));
  const result = await probeBackend(html200, 500);
  assert.equal(result.ok === false && result.kind, "wrong-backend");
});