/* =============================================================================
   Wire -> domain normalisation
   Tolerant readers for the PROPOSED contract. Accepts snake_case or camelCase and
   a few plausible aliases, so the UI keeps working while the backend settles.
   Absent data stays null: nothing here invents a value the backend did not send.
   ============================================================================= */

import type {
  AgentEvent,
  AgentEventType,
  DataOrigin,
  Finding,
  SourceRef,
  StatsBucket,
  TaskAction,
  TaskActionStatus,
  TaskRecord,
  TaskReport,
  TaskStatus,
} from "@/types/domain";
import type {
  EventDto,
  StatsResponse,
  TaskDto,
  TaskListResponse,
  TaskReportDto,
} from "@/types/api";

/* ------------------------------------------------------------------ scalar -- */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First present, non-empty value among the candidate keys. */
function pick(source: Dict, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  // A single object is treated as a one-item list; some backends do this.
  return isDict(value) ? [value] : [];
}

function asIso(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asUrl(value: unknown): string | null {
  const raw = asString(value)?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Some backends report 0..1, some 0..100. Normalise to 0..1, reject nonsense. */
function asProgress(value: unknown): number | null {
  const num = asNumber(value);
  if (num === null) return null;
  const ratio = num > 1 && num <= 100 ? num / 100 : num;
  if (ratio < 0 || ratio > 1) return null;
  return ratio;
}

/* ------------------------------------------------------------------ status -- */

const STATUS_ALIASES: Record<string, TaskStatus> = {
  ready: "ready",
  pending: "queued",
  queued: "queued",
  queued_up: "queued",
  starting: "starting",
  initializing: "starting",
  starting_up: "starting",
  running: "running",
  in_progress: "running",
  active: "running",
  executing: "running",
  awaiting_approval: "awaiting_approval",
  approval_required: "awaiting_approval",
  waiting_for_approval: "awaiting_approval",
  needs_approval: "awaiting_approval",
  completed: "completed",
  complete: "completed",
  succeeded: "completed",
  success: "completed",
  done: "completed",
  finished: "completed",
  failed: "failed",
  failure: "failed",
  error: "failed",
  errored: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  aborted: "cancelled",
  stopped: "cancelled",
};

export function normalizeStatus(value: unknown): TaskStatus {
  const raw = asString(value);
  if (!raw) return "queued";
  return STATUS_ALIASES[raw.toLowerCase().replace(/[\s-]+/g, "_")] ?? "queued";
}

/* ------------------------------------------------------------------ events -- */

const EVENT_TYPE_ALIASES: Record<string, AgentEventType> = {
  task_received: "task_received",
  task_accepted: "task_received",
  received: "task_received",
  agent_started: "agent_started",
  agent_start: "agent_started",
  started: "agent_started",
  browser_opened: "browser_opened",
  browser_launched: "browser_opened",
  browser: "browser_opened",
  page_navigated: "page_navigated",
  navigated: "page_navigated",
  goto: "page_navigated",
  page_loaded: "page_navigated",
  element_inspected: "element_inspected",
  inspecting: "element_inspected",
  inspect: "element_inspected",
  looking_at: "element_inspected",
  action_performed: "action_performed",
  action: "action_performed",
  click: "action_performed",
  typed: "action_performed",
  scrolled: "action_performed",
  information_collected: "information_collected",
  extracted: "information_collected",
  collected: "information_collected",
  data_collected: "information_collected",
  approval_requested: "approval_requested",
  awaiting_approval: "approval_requested",
  task_completed: "task_completed",
  completed: "task_completed",
  task_failed: "task_failed",
  failed: "task_failed",
  task_cancelled: "task_cancelled",
  cancelled: "task_cancelled",
  log: "log",
  message: "log",
  info: "log",
};

export function normalizeEventType(value: unknown): AgentEventType {
  const raw = asString(value);
  if (!raw) return "log";
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return EVENT_TYPE_ALIASES[key] ?? "log";
}

let localEventCounter = 0;

export function nextLocalEventId(): string {
  localEventCounter += 1;
  return `local-${localEventCounter}`;
}

/** Reset so ids stay short within a session; only used by demo + tests. */
export function resetLocalEventIds(): void {
  localEventCounter = 0;
}

export function normalizeEvent(
  dto: EventDto | Dict,
  taskId: string,
  origin: DataOrigin,
  fallbackAt: string,
): AgentEvent {
  const source = isDict(dto) ? dto : {};
  const rawType = asString(pick(source, ["type", "event", "kind", "name"]));
  const at = asIso(pick(source, ["at", "timestamp", "ts", "created_at", "time"])) ?? fallbackAt;
  const dataValue = pick(source, ["data", "payload", "meta"]);
  return {
    id: asString(pick(source, ["id", "event_id", "uuid"])) ?? nextLocalEventId(),
    taskId,
    type: normalizeEventType(rawType),
    message: asString(pick(source, ["message", "text", "summary", "description"])) ?? defaultMessage(rawType),
    at,
    detail: asString(pick(source, ["detail", "details", "reason", "output"])),
    url: asUrl(pick(source, ["url", "page_url", "current_url"])),
    data: isDict(dataValue) ? dataValue : null,
    origin,
  };
}

function defaultMessage(rawType: string | null): string {
  switch (normalizeEventType(rawType)) {
    case "task_received":
      return "Task received.";
    case "agent_started":
      return "Agent started.";
    case "browser_opened":
      return "Browser opened.";
    case "page_navigated":
      return "Page navigated.";
    case "element_inspected":
      return "Element inspected.";
    case "action_performed":
      return "Action performed.";
    case "information_collected":
      return "Information collected.";
    case "approval_requested":
      return "Waiting for approval.";
    case "task_completed":
      return "Task completed.";
    case "task_failed":
      return "Task failed.";
    case "task_cancelled":
      return "Task cancelled.";
    default:
      return "Activity recorded.";
  }
}

/* ------------------------------------------------------------------ report -- */

const ACTION_STATUSES: Record<string, TaskActionStatus> = {
  performed: "performed",
  done: "performed",
  ok: "performed",
  success: "performed",
  succeeded: "performed",
  skipped: "skipped",
  skip: "skipped",
  ignored: "skipped",
  failed: "failed",
  error: "failed",
};

function normalizeActionStatus(value: unknown): TaskActionStatus {
  const raw = asString(value)?.toLowerCase();
  return (raw && ACTION_STATUSES[raw]) || "performed";
}

function normalizeActions(value: unknown): TaskAction[] {
  return asArray(value)
    .map((entry, position): TaskAction | null => {
      if (!isDict(entry)) return null;
      const label =
        asString(pick(entry, ["label", "action", "name", "description", "type", "text"])) ??
        `Step ${position + 1}`;
      return {
        index: asNumber(pick(entry, ["index", "step", "order", "n"])) ?? position + 1,
        at: asIso(pick(entry, ["at", "timestamp", "ts", "time"])) ?? "",
        label,
        target: asString(pick(entry, ["target", "selector", "element", "field"])),
        url: asUrl(pick(entry, ["url", "page_url"])),
        status: normalizeActionStatus(pick(entry, ["status", "result", "outcome"])),
        detail: asString(pick(entry, ["detail", "details", "note", "value"])),
      };
    })
    .filter((action): action is TaskAction => action !== null)
    .map((action, position) => ({ ...action, index: position + 1 }));
}

function normalizeFindings(value: unknown): Finding[] {
  return asArray(value)
    .map((entry, position): Finding | null => {
      if (!isDict(entry)) return null;
      const label = asString(pick(entry, ["label", "key", "name", "field", "title"]));
      const rawValue = pick(entry, ["value", "text", "content", "answer"]);
      const value = asString(rawValue);
      if (value === null) return null;
      return {
        label: label ?? `Finding ${position + 1}`,
        value,
        note: asString(pick(entry, ["note", "notes", "comment", "context"])),
        sourceUrl: asUrl(pick(entry, ["source_url", "sourceUrl", "url", "href"])),
      };
    })
    .filter((finding): finding is Finding => finding !== null);
}

function normalizeSources(value: unknown): SourceRef[] {
  const seen = new Set<string>();
  const refs: SourceRef[] = [];
  for (const entry of asArray(value)) {
    // Sources may be plain strings or objects.
    const url = typeof entry === "string" ? entry : isDict(entry) ? asUrl(pick(entry, ["url", "href", "link", "source"])) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const dict = isDict(entry) ? entry : {};
    let domain = asString(pick(dict, ["domain", "host", "hostname"]));
    if (!domain) {
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        domain = null;
      }
    }
    refs.push({
      url,
      title: asString(pick(dict, ["title", "name", "label"])),
      domain,
      accessedAt: asIso(pick(dict, ["accessed_at", "accessedAt", "retrieved_at", "at"])),
    });
  }
  return refs;
}

function normalizeLimitations(value: unknown): string[] {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (isDict(entry)) return asString(pick(entry, ["message", "text", "note", "detail"]));
      return null;
    })
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function normalizeReport(dto: TaskReportDto | Dict | unknown): TaskReport | null {
  if (!dto || !isDict(dto)) return null;
  const report = dto;
  const summary = asString(pick(report, ["summary", "result_summary", "answer", "conclusion"]));
  const actions = normalizeActions(pick(report, ["actions", "steps_performed", "action_log", "steps"]));
  const findings = normalizeFindings(pick(report, ["findings", "extracted", "data", "results"]));
  const sources = normalizeSources(pick(report, ["sources", "source_urls", "urls", "citations"]));
  const limitations = normalizeLimitations(pick(report, ["limitations", "caveats", "notes"]));
  const raw = report["raw"] ?? report;

  // A report with no content at all is treated as absent rather than empty, so
  // the UI can say "no report returned" instead of showing blank panels.
  const hasContent = Boolean(summary) || actions.length > 0 || findings.length > 0 || sources.length > 0 || limitations.length > 0;
  if (!hasContent) return null;

  return {
    summary: summary ?? "",
    actions,
    findings,
    sources,
    limitations,
    raw,
  };
}

/* -------------------------------------------------------------------- task -- */

function deriveTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (clean.length <= 72) return clean || "Untitled task";
  return `${clean.slice(0, 71).trimEnd()}…`;
}

function deriveDuration(source: Dict): number | null {
  const explicit = asNumber(pick(source, ["duration_ms", "durationMs", "elapsed_ms", "duration"]));
  if (explicit !== null) return explicit >= 0 ? explicit : null;
  const started = asIso(pick(source, ["started_at", "startedAt"]));
  const completed = asIso(pick(source, ["completed_at", "completedAt", "finished_at", "ended_at"]));
  if (started && completed) {
    const delta = new Date(completed).getTime() - new Date(started).getTime();
    return delta >= 0 ? delta : null;
  }
  return null;
}

export function normalizeTask(
  dto: TaskDto | Dict,
  origin: DataOrigin,
  fallbackId = "unknown",
): TaskRecord {
  const source = isDict(dto) ? dto : {};
  const prompt = asString(pick(source, ["prompt", "instruction", "task", "input"])) ?? "";
  const createdAt = asIso(pick(source, ["created_at", "createdAt", "submitted_at"])) ?? new Date().toISOString();
  const errorValue = pick(source, ["error", "failure"]);
  const errorDict = isDict(errorValue) ? errorValue : errorValue ? { message: asString(errorValue) ?? "" } : null;

  return {
    id: asString(pick(source, ["id", "task_id", "taskId"])) ?? fallbackId,
    prompt,
    title: asString(pick(source, ["title", "name", "summary"])) ?? deriveTitle(prompt),
    status: normalizeStatus(pick(source, ["status", "state"])),
    origin,
    createdAt,
    startedAt: asIso(pick(source, ["started_at", "startedAt"])),
    completedAt: asIso(pick(source, ["completed_at", "completedAt", "finished_at", "ended_at"])),
    durationMs: deriveDuration(source),
    progress: asProgress(pick(source, ["progress", "percent_complete", "completion"])),
    currentActivity: asString(pick(source, ["current_activity", "currentActivity", "activity", "step", "current_step"])),
    currentUrl: asUrl(pick(source, ["current_url", "currentUrl", "url", "page_url"])),
    currentTitle: asString(pick(source, ["current_title", "currentTitle", "page_title"])),
    report: normalizeReport(pick(source, ["report", "result", "output"])),
    error: errorDict
      ? {
          message: asString(pick(errorDict, ["message", "detail", "reason"])) ?? "Task failed.",
          code: asString(pick(errorDict, ["code", "type"])),
          retryable: asBoolean(pick(errorDict, ["retryable", "can_retry"])),
        }
      : null,
  };
}

export function normalizeTaskList(dto: TaskListResponse | Dict, origin: DataOrigin): {
  items: TaskRecord[];
  total: number;
  limit: number;
  offset: number;
} {
  const source = isDict(dto) ? dto : {};
  const items = asArray(pick(source, ["items", "tasks", "results", "data"]))
    .filter(isDict)
    .map((entry, index) => normalizeTask(entry, origin, `task-${index}`));
  const total = asNumber(pick(source, ["total", "count", "total_count"])) ?? items.length;
  const limit = asNumber(pick(source, ["limit", "page_size", "pageSize"])) ?? items.length;
  const offset = asNumber(pick(source, ["offset", "skip"])) ?? 0;
  return { items, total, limit, offset };
}

/* ------------------------------------------------------------------- stats -- */

function bucketDate(value: unknown, fallback: string): string {
  const iso = asIso(value);
  if (!iso) return fallback;
  return iso.slice(0, 10);
}

export function normalizeStats(dto: StatsResponse | Dict, origin: DataOrigin): {
  totals: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    cancelledTasks: number;
    successRate: number;
    averageDurationMs: number | null;
  };
  buckets: StatsBucket[];
  recent: TaskRecord[];
} {
  const source = isDict(dto) ? dto : {};
  const totalsDict = isDict(pick(source, ["totals", "summary"])) ? (pick(source, ["totals", "summary"]) as Dict) : source;

  const completed = asNumber(pick(totalsDict, ["completed_tasks", "completedTasks", "completed", "succeeded"])) ?? 0;
  const failed = asNumber(pick(totalsDict, ["failed_tasks", "failedTasks", "failed"])) ?? 0;
  const cancelled = asNumber(pick(totalsDict, ["cancelled_tasks", "cancelledTasks", "canceled_tasks", "cancelled"])) ?? 0;
  const reportedTotal = asNumber(pick(totalsDict, ["total_tasks", "totalTasks", "total", "performed"]));
  const total = reportedTotal ?? completed + failed + cancelled;
  const successRateRaw = asProgress(pick(totalsDict, ["success_rate", "successRate"]));
  const decided = completed + failed;
  const successRate =
    successRateRaw !== null
      ? successRateRaw
      : decided > 0
        ? completed / decided
        : 0;

  const buckets: StatsBucket[] = asArray(pick(source, ["buckets", "series", "timeline", "by_day", "daily"]))
    .filter(isDict)
    .map((entry, index) => {
      const date = bucketDate(pick(entry, ["date", "day", "bucket", "label"]), `1970-01-${String(index + 1).padStart(2, "0")}`);
      const bucketCompleted = asNumber(pick(entry, ["completed", "completed_tasks", "succeeded"])) ?? 0;
      const bucketFailed = asNumber(pick(entry, ["failed", "failed_tasks"])) ?? 0;
      const bucketCancelled = asNumber(pick(entry, ["cancelled", "canceled", "cancelled_tasks"])) ?? 0;
      const bucketPerformed =
        asNumber(pick(entry, ["performed", "total", "total_tasks", "count"])) ??
        bucketCompleted + bucketFailed + bucketCancelled;
      const bucketSuccess = asProgress(pick(entry, ["success_rate", "successRate"]));
      const bucketDecided = bucketCompleted + bucketFailed;
      return {
        date,
        performed: bucketPerformed,
        completed: bucketCompleted,
        failed: bucketFailed,
        cancelled: bucketCancelled,
        durationMs: asNumber(pick(entry, ["duration_ms", "durationMs", "avg_duration_ms", "average_duration_ms"])),
        successRate:
          bucketSuccess !== null
            ? bucketSuccess
            : bucketDecided > 0
              ? bucketCompleted / bucketDecided
              : null,
      };
    });

  const recent = asArray(pick(source, ["recent", "latest", "recent_tasks"]))
    .filter(isDict)
    .map((entry, index) => normalizeTask(entry, origin, `recent-${index}`));

  return {
    totals: {
      totalTasks: total,
      completedTasks: completed,
      failedTasks: failed,
      cancelledTasks: cancelled,
      successRate,
      averageDurationMs: asNumber(pick(totalsDict, ["average_duration_ms", "averageDurationMs", "avg_duration_ms", "avg_duration"])),
    },
    buckets,
    recent,
  };
}

/* ------------------------------------------------------------------ frames -- */

export function normalizeFramesUrl(dto: unknown): { framesUrl: string | null; snapshotUrl: string | null } {
  if (!isDict(dto)) return { framesUrl: null, snapshotUrl: null };
  return {
    framesUrl: asUrl(pick(dto, ["frames_url", "framesUrl", "stream_url", "streamUrl", "mjpeg_url"])),
    snapshotUrl: asUrl(pick(dto, ["snapshot_url", "snapshotUrl", "latest_url", "latestUrl", "image_url", "screenshot_url"])),
  };
}

/** Append a cache-busting param so a polled snapshot actually refreshes. */
export function withCacheBuster(url: string, at: number): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}t=${at}`;
}