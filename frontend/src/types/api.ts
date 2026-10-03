/* =============================================================================
   Wire (DTO) types — PROPOSED CONTRACT, AWAITING BACKEND CONFIRMATION
   -----------------------------------------------------------------------------
   No AgentWebEinh backend exists yet, so these shapes are a proposal. They are
   the ONLY place the frontend describes backend payloads. Everything the UI
   consumes is produced by `src/lib/api/normalize.ts`.

   Rules for whoever implements the backend:
     * Field names may differ freely — update `normalize.ts`, not components.
     * Keep optional fields optional. Every one of them drives a real UI state
       (indeterminate progress, missing sources, unknown duration).
     * `docs/API_CONTRACT.md` is the human-readable version of this file.
   ============================================================================= */

import type {
  AgentEvent,
  AgentEventType,
  DataOrigin,
  StatsBucket,
  TaskAction,
  TaskReport,
  TaskStatus,
} from "./domain";

/** Every JSON error should look like this so the UI can show something useful. */
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    /** Field-level messages for form validation. */
    fields?: Record<string, string>;
  };
  detail?: string;
}

/* --------------------------------------------------------------- requests -- */

export interface CreateTaskRequest {
  prompt: string;
  /** Optional client-generated id, echoed back so the UI can attach early. */
  clientRequestId?: string;
}

export interface CreateTaskResponse {
  taskId: string;
  status: TaskStatus;
  /** Where live updates for this task will be delivered. May be absent if the
   *  backend only supports polling. */
  eventsUrl?: string;
  createdAt?: string;
}

/* ------------------------------------------------------------------ tasks -- */

/** GET /api/tasks */
export interface TaskListResponse {
  items: TaskDto[];
  total: number;
  limit?: number;
  offset?: number;
}

/** GET /api/tasks/{id} */
export type TaskDetailResponse = TaskDto;

export interface TaskDto {
  id: string;
  prompt: string;
  title?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  /** 0..1, omit when unknown. */
  progress?: number | null;
  currentActivity?: string | null;
  currentUrl?: string | null;
  currentTitle?: string | null;
  error?: { message: string; code?: string | null; retryable?: boolean | null } | null;
  report?: TaskReportDto | null;
}

/* ----------------------------------------------------------------- events -- */

/** Individual message delivered over the task WebSocket / SSE stream. */
export interface EventDto {
  id?: string;
  type: AgentEventType | string;
  message?: string;
  at?: string;
  detail?: string | null;
  url?: string | null;
  data?: Record<string, unknown> | null;
}

/** Envelope pushed on every live connection. */
export interface TaskStreamMessage {
  /** Increments per connection; lets the UI detect gaps and re-sync. */
  seq?: number;
  /** Server clock, so the UI never depends on client clock skew. */
  serverTime?: string;
  event?: EventDto;
  /** Full snapshot, expected right after connect and after any gap. */
  snapshot?: TaskDto;
  /** Terminal frames may repeat the final record. */
  task?: TaskDto;
}

/* ----------------------------------------------------------------- report -- */

export interface TaskReportDto {
  summary?: string;
  actions?: TaskActionDto[];
  findings?: FindingDto[];
  sources?: SourceDto[];
  limitations?: string[];
  raw?: unknown;
}

export interface TaskActionDto {
  index?: number;
  at?: string;
  label?: string;
  target?: string | null;
  url?: string | null;
  status?: string;
  detail?: string | null;
}

export interface FindingDto {
  label?: string;
  value?: string;
  note?: string | null;
  sourceUrl?: string | null;
}

export interface SourceDto {
  url?: string;
  title?: string | null;
  domain?: string | null;
  accessedAt?: string | null;
}

/* ----------------------------------------------------------------- status -- */

/**
 * GET /api/status and GET /health — `backend/app/schemas/stats.py::StatusResponse`.
 *
 * This document is also the frontend's identity check: a listener that cannot
 * produce this shape is not AgentWebEinh and must not be treated as the live
 * backend. `components.database` and `components.task_manager` are the two keys
 * `isAgentWebEinhStatus` requires for that reason.
 */
export interface ComponentStatusDto {
  state?: string;
  detail?: string | null;
  latency_ms?: number | null;
  version?: string | null;
}

export interface StatusResponseDto {
  status?: "healthy" | "degraded" | "unhealthy";
  healthy?: boolean;
  version?: string;
  environment?: string;
  server_time?: string;
  uptime_seconds?: number;
  public_base_url?: string;
  components?: Record<string, ComponentStatusDto>;
  ollama?: Record<string, unknown> | null;
  openclaw?: Record<string, unknown> | null;
  browser?: Record<string, unknown> | null;
  tinyfish?: Record<string, unknown> | null;
  notes?: string[];
}

/* ------------------------------------------------------------------ stats -- */

/**
 * GET /api/stats?range=30d — `backend/app/schemas/stats.py::StatsResponse`.
 *
 * The backend emits **flat, top-level** counters with `buckets` and `recent` at
 * the root; there is no `totals` wrapper. `normalizeStats` still accepts a nested
 * `{totals:{...}}` for tolerance with other backends, but the declared shape is
 * the one this backend actually sends. `success_rate` is a 0..1 ratio.
 */
export interface StatsResponse {
  total_tasks?: number;
  completed_tasks?: number;
  failed_tasks?: number;
  cancelled_tasks?: number;
  success_rate?: number;
  average_duration_ms?: number | null;
  range?: string;
  buckets?: StatsBucketDto[];
  recent?: TaskDto[];
}

export interface StatsBucketDto {
  date?: string;
  performed?: number;
  completed?: number;
  failed?: number;
  cancelled?: number;
  duration_ms?: number | null;
  success_rate?: number | null;
}

/* ------------------------------------------------------------------ frames -- */

/**
 * Browser frames. The frontend is transport-agnostic: it renders whatever URL
 * the backend hands it as a still image and animates on change. Three shapes are
 * supported, pick whichever the agent can produce:
 *
 *  1. `framesUrl`  — multipart/chunked stream of stills (simplest).
 *  2. `framesUrl`  — MJPEG stream, same tag, no JS needed.
 *  3. `snapshotUrl` — polled URL that returns the newest JPEG each request.
 *
 * The frontend re-fetches `snapshotUrl` whenever a `page_navigated` /
 * `browser_opened` event arrives, and continuously while `framesUrl` is set.
 */
export interface TaskFramesDto {
  taskId?: string;
  framesUrl?: string | null;
  snapshotUrl?: string | null;
  capturedAt?: string | null;
  width?: number | null;
  height?: number | null;
}

/* ------------------------------------------------------------------ mapping */

export type { AgentEvent, TaskAction, TaskReport, StatsBucket, DataOrigin };

/** Canonical field names the normalizer expects. Documented in API_CONTRACT.md */
export const WIRE_FIELD_MAP = {
  taskId: ["task_id", "id"],
  prompt: ["prompt", "instruction", "task", "input"],
  title: ["title", "name", "summary"],
  status: ["status", "state"],
  createdAt: ["created_at", "createdAt", "submitted_at"],
  startedAt: ["started_at", "startedAt"],
  completedAt: ["completed_at", "completedAt", "finished_at", "ended_at"],
  durationMs: ["duration_ms", "durationMs", "elapsed_ms"],
  progress: ["progress", "percent_complete", "completion"],
  currentActivity: ["current_activity", "currentActivity", "activity", "step"],
  currentUrl: ["current_url", "currentUrl", "url"],
  currentTitle: ["current_title", "currentTitle", "page_title"],
  events: ["events", "activity", "timeline", "steps"],
  report: ["report", "result", "output"],
  sources: ["sources", "source_urls", "urls", "citations"],
  findings: ["findings", "extracted", "data", "results"],
  actions: ["actions", "steps_performed", "action_log"],
  limitations: ["limitations", "caveats", "notes"],
  summary: ["summary", "result_summary", "answer", "conclusion"],
} as const;