/* =============================================================================
   Frame surface contract
   -----------------------------------------------------------------------------
   The snapshot route 404s twice in normal operation: before the agent's first
   screenshot, and after the task settles (the orchestrator drops the frame store
   on purpose). Only a load that fails *after* a frame was seen, while the task
   is still running, is a real failure.

   These tests pin that down, because the previous behaviour -- reporting every
   404 as a dead stream -- put "The frame stream stopped delivering images." at
   the bottom of every successful run.
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  frameBadgeLabel,
  framePlaceholderCopy,
  frameSurfaceState,
  isFrameStreamFailure,
  type FrameSignals,
} from "../src/lib/frames";

const base: FrameSignals = {
  isDemo: false,
  hasImage: false,
  sawFrame: false,
  runIsLive: true,
  hasFeed: true,
  loadFailed: false,
};

test("a 404 before the first screenshot is not a stream failure", () => {
  assert.equal(isFrameStreamFailure({ sawFrame: false, runIsLive: true }), false);
  assert.equal(frameSurfaceState(base), "waiting");
});

test("a 404 after the task settles is not a stream failure", () => {
  // The orchestrator clears the frame store on completion, so the final poll of
  // every successful run 404s. This is the case that was reported as a crash.
  assert.equal(isFrameStreamFailure({ sawFrame: true, runIsLive: false }), false);
  assert.equal(frameSurfaceState({ ...base, sawFrame: true, runIsLive: false }), "closed");
});

test("a feed that dies mid-run is a real failure", () => {
  assert.equal(isFrameStreamFailure({ sawFrame: true, runIsLive: true }), true);
  assert.equal(
    frameSurfaceState({ ...base, sawFrame: true, loadFailed: true }),
    "failed",
  );
});

test("a decoded frame is live, and stays visible when a later load fails", () => {
  assert.equal(
    frameSurfaceState({ ...base, hasImage: true, sawFrame: true }),
    "live",
  );
  // The last good frame is kept on screen; the freshness badge covers staleness.
  assert.equal(
    frameSurfaceState({ ...base, hasImage: true, sawFrame: true, loadFailed: true }),
    "failed",
  );
});

test("no feed at all is reported as unavailable, not as waiting", () => {
  assert.equal(frameSurfaceState({ ...base, hasFeed: false }), "unavailable");
  assert.equal(
    frameSurfaceState({ ...base, hasFeed: false, runIsLive: false, sawFrame: true }),
    "closed",
  );
});

test("demo mode never claims a live frame", () => {
  assert.equal(frameSurfaceState({ ...base, isDemo: true, hasImage: false }), "demo");
  assert.equal(frameSurfaceState({ ...base, isDemo: true, hasImage: true, sawFrame: true }), "demo");
});

test("each state explains itself and never blames a missing feed falsely", () => {
  const waiting = framePlaceholderCopy("waiting");
  const closed = framePlaceholderCopy("closed");
  const unavailable = framePlaceholderCopy("unavailable");

  assert.match(waiting.body, /first screenshot/i);
  assert.match(closed.body, /finished/i);
  assert.match(unavailable.body, /does not expose a frame feed/i);

  // "closed" must not claim the backend lacks a feed: it had one and released it.
  assert.doesNotMatch(closed.body, /does not expose a frame feed/i);
  assert.equal(frameBadgeLabel("waiting"), "Starting browser");
  assert.equal(frameBadgeLabel("closed"), "Finished");
  assert.equal(frameBadgeLabel("live"), null);
});

test("the backend really does release frames when a task settles", () => {
  // Guards the premise of the "closed" state: if the orchestrator stopped
  // clearing the frame store, the 404 would no longer be expected.
  const orchestrator = readFileSync(
    fileURLToPath(new URL("../../backend/app/core/orchestrator.py", import.meta.url)),
    "utf8",
  );
  assert.match(orchestrator, /self\._frames\.clear\(context\.task_id\)/);
});