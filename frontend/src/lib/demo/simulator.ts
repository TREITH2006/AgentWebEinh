/* =============================================================================
   DEMO RUN SIMULATOR — NOT AN AGENT
   -----------------------------------------------------------------------------
   Produces a scripted, clearly-labelled run so the live execution workspace can be
   reviewed without a backend. It emits the same `StreamUpdate` shape as the real
   `TaskEventStream`, so the UI cannot tell them apart structurally — only by the
   `origin: "demo"` tag, which the UI renders as a visible "Simulated" marker.

   Two deliberate constraints:
     * It never emits a browser frame. The viewport shows an explicit
       "no live browser stream" state instead of a simulated screenshot.
     * It never reports progress. The workspace therefore exercises the honest
       "progress not reported by the agent" path.
   ============================================================================= */

import type { AgentEvent, TaskRecord, TaskStatus } from "@/types/domain";
import type { StreamUpdate } from "@/lib/api/events";
import { archetypeForPrompt, DEMO_ORIGIN } from "./fixtures";

export interface DemoRunHandle {
  start(): void;
  close(): void;
}

interface ScriptedStep {
  delayMs: number;
  build: (taskId: string) => AgentEvent;
  /** Task fields to publish alongside this step. */
  activity?: string;
  url?: string | null;
  title?: string | null;
  status?: TaskStatus;
}

function eventId(taskId: string, step: number): string {
  return `${taskId}-demo-${String(step).padStart(3, "0")}`;
}

function makeEvent(
  taskId: string,
  step: number,
  type: AgentEvent["type"],
  message: string,
  at: number,
  extra: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    id: eventId(taskId, step),
    taskId,
    type,
    message,
    at: new Date(at).toISOString(),
    detail: extra.detail ?? null,
    url: extra.url ?? null,
    data: extra.data ?? null,
    origin: DEMO_ORIGIN,
  };
}

/** Deterministically vary pacing so repeated runs do not feel identical. */
function hash(prompt: string): number {
  let value = 2166136261;
  for (let i = 0; i < prompt.length; i += 1) {
    value ^= prompt.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967296;
}

export function buildDemoScript(prompt: string): { steps: ScriptedStep[]; outcome: TaskStatus; taskId: string } {
  const archetype = archetypeForPrompt(prompt);
  const jitter = hash(prompt);
  const taskId = `demo-run-${Math.floor(jitter * 1e6).toString(36)}`;

  // A small number of prompts are scripted to fail so the error path is reviewable.
  const outcome: TaskStatus = jitter > 0.9 ? "failed" : "completed";

  const site = archetype.sites[0];
  const steps: ScriptedStep[] = [];
  const pace = 520 + Math.round(jitter * 380);
  let cursor = 0;
  let step = 0;
  const startedAt = Date.now();

  const push = (step_: ScriptedStep): void => {
    step += 1;
    steps.push({ ...step_, delayMs: step_.delayMs });
  };

  push({
    delayMs: 0,
    build: (id) => makeEvent(id, step, "task_received", "Task received and queued.", startedAt, { detail: prompt }),
  });

  cursor += pace;
  push({
    delayMs: cursor,
    build: (id) => makeEvent(id, step, "agent_started", "Agent started working on the task.", startedAt + cursor),
    activity: "Starting the agent",
  });

  cursor += pace + 700;
  push({
    delayMs: cursor,
    build: (id) => makeEvent(id, step, "browser_opened", "Browser session opened.", startedAt + cursor),
    activity: "Opening a browser session",
  });

  cursor += pace + 900;
  push({
    delayMs: cursor,
    build: (id) =>
      makeEvent(id, step, "page_navigated", `Navigated to ${site?.title ?? "the target page"}.`, startedAt + cursor, {
        url: site?.url ?? null,
      }),
    activity: "Opening the target page",
    url: site?.url ?? null,
    title: site?.title ?? null,
  });

  for (const action of archetype.actions) {
    cursor += pace + 500;
    push({
      delayMs: cursor,
      build: (id) =>
        makeEvent(id, step, "element_inspected", `Inspecting ${action.target}.`, startedAt + cursor, {
          url: site?.url ?? null,
          detail: action.target,
        }),
      activity: `Inspecting ${action.target}`,
      url: site?.url ?? null,
    });

    cursor += pace + 800;
    push({
      delayMs: cursor,
      build: (id) =>
        makeEvent(id, step, "action_performed", action.label, startedAt + cursor, {
          url: site?.url ?? null,
          detail: action.target,
        }),
      activity: action.label,
      url: site?.url ?? null,
    });
  }

  const findingCount = Math.min(archetype.findings.length, 3);
  for (let i = 0; i < findingCount; i += 1) {
    cursor += pace + 700;
    const finding = archetype.findings[i];
    push({
      delayMs: cursor,
      build: (id) =>
        makeEvent(id, step, "information_collected", `Collected “${finding?.label ?? "result"}”.`, startedAt + cursor, {
          url: archetype.sites[i % archetype.sites.length]?.url ?? null,
          detail: finding?.value ?? null,
        }),
      activity: "Collecting information",
    });
  }

  cursor += pace + 900;
  push({
    delayMs: cursor,
    build: (id) =>
      makeEvent(id, step, "information_collected", `Sources recorded: ${archetype.sites.length}.`, startedAt + cursor, {
        data: { sources: archetype.sites.map((entry) => entry.url) },
      }),
    activity: "Recording sources",
  });

  if (outcome === "failed") {
    cursor += pace + 600;
    push({
      delayMs: cursor,
      build: (id) =>
        makeEvent(id, step, "task_failed", "The agent could not complete the task.", startedAt + cursor, {
          detail: "This run was scripted to fail so the failure state can be reviewed.",
        }),
      activity: "Ending the run",
      status: "failed",
    });
    return { steps, outcome, taskId };
  }

  cursor += pace + 1_000;
  push({
    delayMs: cursor,
    build: (id) => makeEvent(id, step, "task_completed", "Task completed.", startedAt + cursor),
    activity: "Finishing up",
    status: "completed",
  });

  return { steps, outcome, taskId };
}

/** A demo run that satisfies the same interface as the live `TaskEventStream`. */
export class DemoRunSession implements DemoRunHandle {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closed = false;

  constructor(
    private readonly prompt: string,
    private readonly onUpdate: (update: StreamUpdate) => void,
  ) {}

  start(): void {
    this.onUpdate({ kind: "transport", transport: "websocket", detail: "Simulated stream (demo mode)." });

    const { steps, outcome, taskId } = buildDemoScript(this.prompt);
    const startedAt = Date.now();
    let status: TaskStatus = "queued";

    // Baseline snapshot so the workspace has a record to render immediately.
    this.onUpdate({
      kind: "task",
      task: buildSnapshot(taskId, this.prompt, "queued", null, startedAt),
    });

    for (const step of steps) {
      const timer = setTimeout(() => {
        if (this.closed) return;
        if (step.status) status = step.status;
        this.onUpdate({ kind: "event", event: step.build(taskId) });
        this.onUpdate({
          kind: "task",
          task: buildSnapshot(
            taskId,
            this.prompt,
            status,
            {
              activity: step.activity ?? null,
              url: step.url ?? null,
              title: step.title ?? null,
            },
            startedAt,
          ),
        });
      }, step.delayMs);
      this.timers.push(timer);
    }

    // Final record so the report has timestamps and a duration.
    const total = (steps.at(-1)?.delayMs ?? 0) + 1_200;
    const finalTimer = setTimeout(() => {
      if (this.closed) return;
      this.onUpdate({
        kind: "task",
        task: buildSnapshot(taskId, this.prompt, outcome, null, startedAt, true),
      });
    }, total);
    this.timers.push(finalTimer);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.onUpdate({ kind: "transport", transport: "closed" });
  }
}

function buildSnapshot(
  taskId: string,
  prompt: string,
  status: TaskStatus,
  live: { activity: string | null; url: string | null; title: string | null } | null,
  startedAt: number,
  final = false,
): TaskRecord {
  const now = Date.now();
  const isDone = final || status === "completed" || status === "failed";
  return {
    id: taskId,
    prompt,
    title: prompt.slice(0, 72).length === prompt.length ? prompt : `${prompt.slice(0, 71).trimEnd()}…`,
    status,
    origin: DEMO_ORIGIN,
    createdAt: new Date(startedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: isDone ? new Date(now).toISOString() : null,
    durationMs: isDone ? now - startedAt : null,
    // Intentionally null: the demo does not stand in for a backend progress feed.
    progress: null,
    currentActivity: live?.activity ?? null,
    currentUrl: live?.url ?? null,
    currentTitle: live?.title ?? null,
    report: null,
    error:
      status === "failed"
        ? {
            message: "This run was scripted to fail so the failure state can be reviewed.",
            code: "DEMO_SCRIPTED_FAILURE",
            retryable: true,
          }
        : null,
  };
}