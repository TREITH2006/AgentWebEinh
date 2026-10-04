/* =============================================================================
   Frame surface state
   -----------------------------------------------------------------------------
   The backend answers the snapshot route with 404 in two ordinary situations,
   and neither one is a broken stream:

     - before the agent has taken its first screenshot, and
     - after the task settles, because the orchestrator drops the frame store on
       purpose so a finished task is not shown next to a stale screenshot.

   A third case, a feed that dies while the task is still running, is a real
   failure and the only one worth reporting. Getting this wrong is not cosmetic:
   an earlier version reported every 404 as a dead stream, so every successful
   run ended with "The frame stream stopped delivering images."

   These are pure functions so the rules are testable without a DOM.
   ============================================================================= */

export type FrameSurfaceState =
  /** Demo mode: scripted, no real browser, never an image. */
  | "demo"
  /** A frame decoded and is on screen. */
  | "live"
  /** The run is live but no frame has decoded yet. */
  | "waiting"
  /** The run is over and the backend released the live view. */
  | "closed"
  /** No frame feed to wait for. */
  | "unavailable"
  /** The feed died while the run was still going. */
  | "failed";

export interface FrameSignals {
  isDemo: boolean;
  /** An image is currently decoded and displayed. */
  hasImage: boolean;
  /** An image has decoded at least once for this task. */
  sawFrame: boolean;
  /** The task is queued, starting or running. */
  runIsLive: boolean;
  /** The backend advertised a frame feed for this task. */
  hasFeed: boolean;
  /** The most recent image load failed. */
  loadFailed: boolean;
}

/**
 * Did the frame stream genuinely fail?
 *
 * Both 404 cases are expected, so they must not raise an alarm; only a load
 * that failed after a frame was seen, while the task is still running, is a
 * stream the user needs to know about.
 */
export function isFrameStreamFailure({ sawFrame, runIsLive }: Pick<FrameSignals, "sawFrame" | "runIsLive">): boolean {
  return sawFrame && runIsLive;
}

/** Classify what the viewport should show, and what to call it. */
export function frameSurfaceState({
  isDemo,
  hasImage,
  sawFrame,
  runIsLive,
  hasFeed,
  loadFailed,
}: FrameSignals): FrameSurfaceState {
  if (isDemo) return "demo";
  if (hasImage) return loadFailed ? "failed" : "live";
  if (!runIsLive) return sawFrame ? "closed" : "unavailable";
  if (!sawFrame) return hasFeed ? "waiting" : "unavailable";
  return "failed";
}

const COPY: Record<FrameSurfaceState, { title: string; body: string }> = {
  demo: {
    title: "Simulated session",
    body: "Demo mode scripts the event stream but never opens a real browser, so there is no screen to show. Connect the backend to receive live frames here.",
  },
  live: { title: "", body: "" },
  waiting: {
    title: "Waiting for the first frame",
    body: "This task is queued behind another one, or the agent has not opened a page yet. The browser view appears the moment the first screenshot is captured.",
  },
  closed: {
    title: "Live view closed",
    body: "The task finished, so the backend released its live browser view. The report below is the result of that run.",
  },
  unavailable: {
    title: "No live browser stream",
    body: "This backend does not expose a frame feed yet. The agent still reports each page it opens below, so you can follow its progress without the visual.",
  },
  failed: {
    title: "No live browser stream",
    body: "This backend does not expose a frame feed yet. The agent still reports each page it opens below, so you can follow its progress without the visual.",
  },
};

/** Placeholder heading and explanation for a non-live state. */
export function framePlaceholderCopy(state: FrameSurfaceState): { title: string; body: string } {
  return COPY[state];
}

/** Short status label shown beside the viewport heading. */
export function frameBadgeLabel(state: FrameSurfaceState): string | null {
  switch (state) {
    case "demo":
      return "Simulated";
    case "waiting":
      return "Starting browser";
    case "closed":
      return "Finished";
    case "unavailable":
    case "failed":
      return "No stream";
    default:
      return null;
  }
}