/* =============================================================================
   DEMO REPOSITORY — resolves the report for a synthetic task.
   Demo-only helper used by the demo service so a demo run in the current session
   can still produce a full report without a backend.
   ============================================================================= */

import type { AgentEvent, TaskRecord, TaskReport } from "@/types/domain";
import { archetypeForPrompt, getDemoTasks, DEMO_ORIGIN } from "./fixtures";

const MEMORY = new Map<string, { prompt: string; createdAt: string; report: TaskReport | null; status: TaskRecord["status"] }>();
const EVENTS = new Map<string, AgentEvent[]>();

export function findDemoTask(taskId: string): TaskRecord | null {
  const inMemory = MEMORY.get(taskId);
  if (inMemory) {
    return {
      id: taskId,
      prompt: inMemory.prompt,
      title: inMemory.prompt.slice(0, 72),
      status: inMemory.status,
      origin: DEMO_ORIGIN,
      createdAt: inMemory.createdAt,
      startedAt: inMemory.createdAt,
      completedAt: inMemory.createdAt,
      durationMs: 0,
      progress: null,
      report: inMemory.report,
      error: null,
    };
  }
  return getDemoTasks().find((task) => task.id === taskId) ?? null;
}

/** Register a demo run so it becomes immediately viewable in history/report. */
export function registerDemoRun(input: {
  taskId: string;
  prompt: string;
  status: TaskRecord["status"];
  createdAt: string;
  report: TaskReport | null;
  events: AgentEvent[];
}): void {
  MEMORY.set(input.taskId, {
    prompt: input.prompt,
    createdAt: input.createdAt,
    report: input.report,
    status: input.status,
  });
  EVENTS.set(input.taskId, input.events);
}

export function getDemoEvents(taskId: string): AgentEvent[] {
  return EVENTS.get(taskId) ?? [];
}

/** Demo runs started in this session, newest first. Merged into demo history. */
export function listDemoRuns(): TaskRecord[] {
  const records: TaskRecord[] = [];

  for (const [id, entry] of MEMORY.entries()) {
    records.push({
      id,
      prompt: entry.prompt,
      title: entry.prompt.length <= 72 ? entry.prompt : `${entry.prompt.slice(0, 71).trimEnd()}…`,
      status: entry.status,
      origin: DEMO_ORIGIN,
      createdAt: entry.createdAt,
      startedAt: entry.createdAt,
      completedAt: entry.createdAt,
      durationMs: null,
      progress: null,
      report: entry.report,
      error:
        entry.status === "failed"
          ? {
              message: "This run was scripted to fail so the failure state can be reviewed.",
              code: "DEMO_SCRIPTED_FAILURE",
              retryable: true,
            }
          : null,
    });
  }

  return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function buildDemoReportForTask(taskId: string): TaskReport | null {
  const record = findDemoTask(taskId);
  return record?.report ?? null;
}

/** Builds the report a demo run would have produced, from the prompt archetype. */
export function composeDemoReport(prompt: string, failed: boolean): TaskReport | null {
  if (failed) return null;
  const archetype = archetypeForPrompt(prompt);
  const now = new Date().toISOString();
  return {
    summary: archetype.summary,
    actions: archetype.actions.map((action, index) => ({
      index: index + 1,
      at: new Date(Date.parse(now) - (archetype.actions.length - index) * 4_000).toISOString(),
      label: action.label,
      target: action.target,
      url: archetype.sites[Math.min(index, archetype.sites.length - 1)]?.url ?? null,
      status: "performed" as const,
      detail: null,
    })),
    findings: archetype.findings.map((finding, index) => ({
      label: finding.label,
      value: finding.value,
      note: index === 0 ? "First result on the page." : null,
      sourceUrl: archetype.sites[index % archetype.sites.length]?.url ?? null,
    })),
    sources: archetype.sites.map((site) => ({
      url: site.url,
      title: site.title,
      domain: new URL(site.url).hostname.replace(/^www\./, ""),
      accessedAt: now,
    })),
    limitations: [...archetype.limitations],
    raw: null,
  };
}