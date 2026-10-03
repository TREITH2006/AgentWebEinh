/* =============================================================================
   Service contract
   One interface, two implementations: `createLiveService` (REST against the
   backend) and `createDemoService` (synthetic fixtures). Components depend only
   on this interface, which is why demo data can never leak into real logic and
   real data can never be faked.
   ============================================================================= */

import type {
  AgentEvent,
  DataOrigin,
  StatsRange,
  TaskRecord,
  TaskStats,
} from "@/types/domain";
import type { TaskListParams } from "./tasks";
import { cancelTask, createTask, fetchTask, fetchTaskEvents, fetchTaskFrames, fetchTasks } from "./tasks";
import { fetchStats } from "./stats";
import { getDemoStats, getDemoTasks, DEMO_ORIGIN } from "@/lib/demo/fixtures";
import { composeDemoReport, getDemoEvents, listDemoRuns, findDemoTask } from "@/lib/demo/repository";

export interface TaskPage {
  items: TaskRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface FrameEndpoints {
  framesUrl: string | null;
  snapshotUrl: string | null;
}

export interface CreateTaskResult {
  taskId: string;
  status: TaskRecord["status"];
  eventsUrl: string | null;
}

export interface AgentService {
  readonly origin: DataOrigin;
  /** False when the backend exposes no cancellation route, or in demo mode. */
  readonly supportsCancellation: boolean;
  listTasks(params?: TaskListParams, signal?: AbortSignal): Promise<TaskPage>;
  getTask(taskId: string, signal?: AbortSignal): Promise<TaskRecord>;
  getTaskEvents(taskId: string, signal?: AbortSignal): Promise<AgentEvent[]>;
  getTaskFrames(taskId: string, signal?: AbortSignal): Promise<FrameEndpoints>;
  getStats(range: StatsRange, signal?: AbortSignal): Promise<TaskStats>;
  /** Throws in demo mode; returns false when the route is unsupported. */
  cancelTask(taskId: string, signal?: AbortSignal): Promise<boolean>;
}

export interface CreateTaskFn {
  (prompt: string, signal?: AbortSignal): Promise<CreateTaskResult>;
}

/* ------------------------------------------------------------------- live -- */

export function createLiveService(): AgentService {
  const origin: DataOrigin = "api";
  return {
    origin,
    supportsCancellation: true,
    listTasks: async (params = {}, signal) => fetchTasks(params, origin, signal),
    getTask: async (taskId, signal) => fetchTask(taskId, origin, signal),
    getTaskEvents: async (taskId, signal) => fetchTaskEvents(taskId, origin, signal),
    getTaskFrames: async (taskId, signal) => fetchTaskFrames(taskId, signal),
    getStats: async (range, signal) => fetchStats(range, origin, signal),
    cancelTask,
  };
}

export const createLiveTask: CreateTaskFn = (prompt, signal) => createTask({ prompt }, signal);

/* ------------------------------------------------------------------- demo -- */

/** Simulates network latency so loading states are exercised honestly. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createDemoService(): AgentService {
  return {
    origin: DEMO_ORIGIN,
    supportsCancellation: false,
    listTasks: async (params = {}, signal) => {
      await delay(420, signal);
      const { search, status, sort, limit, offset } = params;
      // Session runs from this browser come first, then the seeded fixture set.
      let items = [...listDemoRuns(), ...getDemoTasks()];

      if (search && search.trim()) {
        const needle = search.trim().toLowerCase();
        items = items.filter(
          (task) =>
            task.title.toLowerCase().includes(needle) ||
            task.prompt.toLowerCase().includes(needle) ||
            task.id.toLowerCase().includes(needle),
        );
      }
      if (status && status !== "all") {
        items = items.filter((task) => task.status === status);
      }

      const sorted = [...items];
      switch (sort) {
        case "oldest":
          sorted.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
          break;
        case "longest":
          sorted.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
          break;
        case "shortest":
          sorted.sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0));
          break;
        default:
          sorted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      }

      const start = offset ?? 0;
      const size = limit ?? sorted.length;
      return { items: sorted.slice(start, start + size), total: sorted.length, limit: size, offset: start };
    },
    getTask: async (taskId, signal) => {
      await delay(340, signal);
      const task = findDemoTask(taskId);
      if (!task) throw new Error("Task not found");
      return task;
    },
    getTaskEvents: async (taskId, signal) => {
      await delay(300, signal);
      return getDemoEvents(taskId);
    },
    getTaskFrames: async () => ({ framesUrl: null, snapshotUrl: null }),
    getStats: async (range, signal) => {
      await delay(520, signal);
      const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
      const { buckets, tasks } = getDemoStats(days);
      const scoped = tasks.filter((task) => {
        const age = Date.now() - Date.parse(task.createdAt);
        return age <= days * 86_400_000;
      });
      const completed = scoped.filter((task) => task.status === "completed");
      const failed = scoped.filter((task) => task.status === "failed");
      const cancelled = scoped.filter((task) => task.status === "cancelled");
      const durations = scoped
        .map((task) => task.durationMs)
        .filter((value): value is number => typeof value === "number" && value > 0);
      const decided = completed.length + failed.length;
      return {
        origin: DEMO_ORIGIN,
        totalTasks: scoped.length,
        completedTasks: completed.length,
        failedTasks: failed.length,
        cancelledTasks: cancelled.length,
        successRate: decided > 0 ? completed.length / decided : 0,
        averageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
        buckets,
        recent: scoped.slice(0, 6),
      };
    },
    cancelTask: async () => false,
  };
}

export { composeDemoReport };