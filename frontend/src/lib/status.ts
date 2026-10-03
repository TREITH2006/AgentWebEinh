/* =============================================================================
   Status vocabulary
   One place that defines how every task status is labelled, coloured, described
   and which events imply it. The badge, the report header and the history filter
   all read from here so wording can never drift between screens.
   ============================================================================= */

import type { AgentEventType, TaskStatus } from "@/types/domain";

export type StatusTone = "idle" | "pending" | "active" | "warning" | "success" | "danger";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Spoken description, used as the accessible title on the badge. */
  description: string;
  /** Whether a pulsing indicator is appropriate. */
  live: boolean;
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  ready: {
    label: "Ready",
    tone: "idle",
    description: "The workspace is idle and waiting for a task.",
    live: false,
  },
  queued: {
    label: "Queued",
    tone: "pending",
    description: "The task has been accepted and is waiting to start.",
    live: true,
  },
  starting: {
    label: "Starting",
    tone: "pending",
    description: "The agent is bringing up its browser session.",
    live: true,
  },
  running: {
    label: "Running",
    tone: "active",
    description: "The agent is working on the task.",
    live: true,
  },
  awaiting_approval: {
    label: "Awaiting approval",
    tone: "warning",
    description: "The agent is paused and waiting for your approval to continue.",
    live: true,
  },
  completed: {
    label: "Completed",
    tone: "success",
    description: "The task finished successfully and a report is available.",
    live: false,
  },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "The task did not finish. See the error and limitations in the report.",
    live: false,
  },
  cancelled: {
    label: "Cancelled",
    tone: "idle",
    description: "The task was stopped before it finished.",
    live: false,
  },
};

export const STATUS_ORDER: readonly TaskStatus[] = [
  "ready",
  "queued",
  "starting",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
];

export function statusMeta(status: TaskStatus): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.ready;
}

/** Grouping used by the history filter: reduces eight filters to four chips. */
export type StatusFilter = "all" | "active" | "completed" | "failed";

export const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Needs attention" },
];

export function matchesStatusFilter(status: TaskStatus, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return status === "queued" || status === "starting" || status === "running" || status === "awaiting_approval";
    case "completed":
      return status === "completed";
    case "failed":
      return status === "failed" || status === "cancelled";
    default:
      return true;
  }
}

/* ---------------------------------------------------------------- events -- */

export interface EventMeta {
  label: string;
  /** Short glyph key resolved by the activity feed. */
  glyph: "task" | "agent" | "browser" | "navigate" | "inspect" | "action" | "collect" | "approval" | "done" | "fail" | "stop" | "log";
  tone: StatusTone;
  /** Which status this event implies, used to derive status when the backend
   *  does not send a status field on the stream. */
  implies?: TaskStatus;
}

export const EVENT_META: Record<AgentEventType, EventMeta> = {
  task_received: { label: "Task received", glyph: "task", tone: "pending", implies: "queued" },
  agent_started: { label: "Agent started", glyph: "agent", tone: "active", implies: "starting" },
  browser_opened: { label: "Browser opened", glyph: "browser", tone: "active", implies: "running" },
  page_navigated: { label: "Page navigated", glyph: "navigate", tone: "active", implies: "running" },
  element_inspected: { label: "Element inspected", glyph: "inspect", tone: "active", implies: "running" },
  action_performed: { label: "Action performed", glyph: "action", tone: "active", implies: "running" },
  information_collected: { label: "Information collected", glyph: "collect", tone: "active", implies: "running" },
  approval_requested: { label: "Approval requested", glyph: "approval", tone: "warning", implies: "awaiting_approval" },
  task_completed: { label: "Task completed", glyph: "done", tone: "success", implies: "completed" },
  task_failed: { label: "Task failed", glyph: "fail", tone: "danger", implies: "failed" },
  task_cancelled: { label: "Task cancelled", glyph: "stop", tone: "idle", implies: "cancelled" },
  log: { label: "Activity", glyph: "log", tone: "idle" },
};

export function eventMeta(type: AgentEventType): EventMeta {
  return EVENT_META[type] ?? EVENT_META.log;
}