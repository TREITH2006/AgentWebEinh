/* =============================================================================
   API endpoints — the single choke point
   -----------------------------------------------------------------------------
   Verified against the FastAPI backend in `backend/app/api/`. Nothing outside this
   file should reference a URL; if a route changes, change it here and nowhere
   else.

   Not listed, on purpose:
   - `/health`     the backend serves it, but it is a generic liveness probe that
                   ANY service can answer with 200. Live/demo selection uses
                   `/api/status` instead, which carries this project's identity.
   - `/stream`     SSE. The backend implements WebSocket at `/{id}/ws` only, so an
                   SSE entry here would only ever produce a 404.
   ============================================================================= */

/** Unversioned prefix keeps the surface small; add `/v1` if the backend versions. */
const PREFIX = "";

export const API_ENDPOINTS = {
  /**
   * Identity + liveness document. Probed to decide live vs demo, so a service
   * that is up but is *not* AgentWebEinh can be rejected by shape instead of
   * being accepted on the strength of a bare 200.
   */
  status: `${PREFIX}/api/status`,

  tasks: `${PREFIX}/api/tasks`,
  task: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}`,

  /** Replayable history of a finished or in-flight task. */
  taskEvents: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/events`,

  /** Cancel / stop an in-flight task. 202 means accepted, not stopped. */
  taskCancel: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/cancel`,

  /** Live event stream (WebSocket). Re-rooted onto /ws/backend by apiWsUrl(). */
  taskSocket: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/ws`,

  /** Browser frames: `{ framesUrl?, snapshotUrl?, capturedAt? }`. */
  taskFrames: (taskId: string) => `${PREFIX}/api/tasks/${encodeURIComponent(taskId)}/frames`,

  stats: `${PREFIX}/api/stats`,
} as const;

export type ApiEndpointName = keyof typeof API_ENDPOINTS;