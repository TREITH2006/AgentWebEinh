/* =============================================================================
   Domain models
   These are the shapes the UI renders. They are frontend-owned and stable.
   `src/types/api.ts` holds the wire DTOs the backend is expected to send and
   `src/lib/api/normalize.ts` maps wire -> domain, so a backend schema change is
   absorbed in one file instead of rippling through the interface.
   ============================================================================= */

/** Where a piece of data came from. Rendered in the UI so demo data is never
 *  mistaken for real agent output. */
export type DataOrigin = "api" | "demo";

export type TaskStatus =
  | "ready"
  | "queued"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "ready",
  "queued",
  "starting",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Statuses where the backend is still expected to push updates. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "queued",
  "starting",
  "running",
  "awaiting_approval",
] as const;

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/* ------------------------------------------------------------------ events -- */

export type AgentEventType =
  | "task_received"
  | "agent_started"
  | "browser_opened"
  | "page_navigated"
  | "element_inspected"
  | "action_performed"
  | "information_collected"
  | "approval_requested"
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  | "log";

export interface AgentEvent {
  id: string;
  taskId: string;
  type: AgentEventType;
  /** Short human sentence rendered in the feed. */
  message: string;
  /** ISO 8601 timestamp supplied by the backend. */
  at: string;
  /** Optional expandable technical detail. */
  detail?: string | null;
  /** Page the agent was on when this happened. */
  url?: string | null;
  /** Free-form structured payload from the backend. */
  data?: Record<string, unknown> | null;
  origin: DataOrigin;
}

/* ------------------------------------------------------------------ report -- */

export type TaskActionStatus = "performed" | "skipped" | "failed";

export interface TaskAction {
  index: number;
  at: string;
  label: string;
  target?: string | null;
  url?: string | null;
  status: TaskActionStatus;
  detail?: string | null;
}

export interface Finding {
  label: string;
  value: string;
  note?: string | null;
  sourceUrl?: string | null;
}

export interface SourceRef {
  url: string;
  title?: string | null;
  domain?: string | null;
  accessedAt?: string | null;
}

export interface TaskReport {
  summary: string;
  actions: TaskAction[];
  findings: Finding[];
  sources: SourceRef[];
  limitations: string[];
  /** Untouched backend payload, shown behind "View task details". */
  raw?: unknown;
}

export interface TaskError {
  message: string;
  code?: string | null;
  retryable?: boolean | null;
}

/* -------------------------------------------------------------------- task -- */

export interface TaskRecord {
  id: string;
  /** Original natural-language instruction. */
  prompt: string;
  /** Short label for lists. Falls back to a prompt excerpt. */
  title: string;
  status: TaskStatus;
  origin: DataOrigin;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Milliseconds. Null unless both timestamps are known. */
  durationMs?: number | null;
  /** 0..1. Null when the backend does not report meaningful progress — the UI
   *  shows an indeterminate indicator rather than inventing a percentage. */
  progress?: number | null;
  currentActivity?: string | null;
  currentUrl?: string | null;
  currentTitle?: string | null;
  report?: TaskReport | null;
  error?: TaskError | null;
}

/* ------------------------------------------------------------------- stats -- */

export interface StatsBucket {
  /** Bucket key: ISO date for day buckets. */
  date: string;
  performed: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Average duration in ms for the bucket, null when no task finished. */
  durationMs: number | null;
  /** Completed / (completed + failed) as 0..1, null when undefined. */
  successRate: number | null;
}

export interface TaskStats {
  origin: DataOrigin;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  /** 0..1 */
  successRate: number;
  averageDurationMs: number | null;
  buckets: StatsBucket[];
  recent: TaskRecord[];
}

export type StatsRange = "7d" | "30d" | "90d";

/* ------------------------------------------------------------------ frames -- */

/** A live browser frame. `image` is a real backend-provided capture; `pending`
 *  is the honest state when no frame transport exists yet. There is deliberately
 *  no "fake frame" variant — simulated sessions render `null` frames plus an
 *  explicit simulated banner instead of imitating a screenshot. */
export type BrowserFrame =
  | { kind: "image"; src: string; at: string; label?: string | null }
  | { kind: "pending" };

export interface NewTaskInput {
  prompt: string;
}

/* -------------------------------------------------------------- pagination -- */

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}