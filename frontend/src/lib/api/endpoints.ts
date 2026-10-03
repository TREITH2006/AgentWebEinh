/* =============================================================================
   API endpoints — the single choke point
   -----------------------------------------------------------------------------
   PROPOSED. No AgentWebEinh backend exists yet, so every path below is a
   proposal awaiting backend confirmation. Nothing outside this file should
   reference a URL. If the real backend uses different routes, change them here
   and nowhere else.
   ============================================================================= */

/** Unversioned prefix keeps the surface small; add `/v1` if the backend versions. */
const PREFIX = "";

export const API_ENDPOINTS = {
  /** Liveness probe used to decide live vs demo. Should be cheap and unauthenticated. */
  health: `${PREFIX}/health`,

  tasks: `${PREFIX}/api/tasks`,
  task: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}`,

  /** Replayable history of a finished or in-flight task. */
  taskEvents: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/events`,

  /** Cancel / stop an in-flight task. Optional — the Stop control hides itself
   *  when a probe reports this route is unsupported. */
  taskCancel: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/cancel`,

  /** Live event stream (WebSocket). */
  taskSocket: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/ws`,

  /** Optional SSE fallback for the same event stream. */
  taskStream: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/stream`,

  /** Browser frames: `{ framesUrl?, snapshotUrl?, capturedAt? }`. */
  taskFrames: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/frames`,

  stats: `${PREFIX}/api/stats`,
} as const;

export type ApiEndpointName = keyof typeof API_ENDPOINTS;