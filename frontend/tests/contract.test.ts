/* =============================================================================
   Request/response contract
   -----------------------------------------------------------------------------
   Asserts that what the frontend sends matches what the backend actually reads,
   by reading `backend/app/api/*.py` rather than the frontend's own assumptions.
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { fetchStats } from "../src/lib/api/stats";
import { API_ENDPOINTS } from "../src/lib/api/endpoints";

interface Captured {
  url: string;
}

/** Replace global fetch for the duration of `run`, recording every URL. */
async function withStubbedFetch<T>(run: () => Promise<T>): Promise<{ value: T; captured: Captured[] }> {
  const original = globalThis.fetch;
  const captured: Captured[] = [];

  globalThis.fetch = ((input: RequestInfo | URL) => {
    captured.push({ url: String(input) });
    return Promise.resolve(
      new Response(JSON.stringify({ total_tasks: 0, buckets: [], recent: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    return { value: await run(), captured };
  } finally {
    globalThis.fetch = original;
  }
}

test("stats request sends only the range parameter", async () => {
  // backend/app/api/stats.py declares one query parameter: `range`. It ignores
  // unknown keys, so a stray `bucket` would not error — it would silently lie
  // about the granularity the caller asked for.
  const { captured } = await withStubbedFetch(() => fetchStats("7d", "api"));

  assert.equal(captured.length, 1);
  const [entry] = captured;
  assert.ok(entry, "expected exactly one request");
  const url = new URL(entry.url, "http://frontend.invalid");
  assert.equal(url.pathname, "/api/backend/api/stats");
  assert.equal(url.searchParams.get("range"), "7d");
  assert.equal(url.searchParams.has("bucket"), false, "backend ignores `bucket`; do not send it");
  assert.deepEqual([...url.searchParams.keys()], ["range"]);
});

test("endpoint table matches the routes the backend registers", () => {
  assert.equal(API_ENDPOINTS.status, "/api/status");
  assert.equal(API_ENDPOINTS.stats, "/api/stats");
  assert.equal(API_ENDPOINTS.tasks, "/api/tasks");
  assert.equal(API_ENDPOINTS.task("01ABC"), "/api/tasks/01ABC");
  assert.equal(API_ENDPOINTS.taskEvents("01ABC"), "/api/tasks/01ABC/events");
  assert.equal(API_ENDPOINTS.taskCancel("01ABC"), "/api/tasks/01ABC/cancel");
  assert.equal(API_ENDPOINTS.taskFrames("01ABC"), "/api/tasks/01ABC/frames");
  // WebSocket path; apiWsUrl() re-roots it onto /ws/backend.
  assert.equal(API_ENDPOINTS.taskSocket("01ABC"), "/api/tasks/01ABC/ws");
});

test("task ids are URL-encoded so a hostile id cannot escape the path", () => {
  // The backend validates a prefixed ULID and returns 422 otherwise; encoding
  // keeps a malformed id from turning into extra path segments.
  assert.equal(API_ENDPOINTS.task("a/../b"), "/api/tasks/a%2F..%2Fb");
  assert.equal(API_ENDPOINTS.task("a b"), "/api/tasks/a%20b");
});

test("no endpoint claims a route the backend does not implement", () => {
  const serialized = JSON.stringify(API_ENDPOINTS, (_key, value) =>
    typeof value === "function" ? undefined : value,
  );
  // SSE was previously declared here; the backend serves WebSocket only.
  assert.doesNotMatch(serialized, /\/stream$/);
  // `/health` answers 200 for unrelated services, so it must not be the probe.
  assert.doesNotMatch(serialized, /\/health$/);
});