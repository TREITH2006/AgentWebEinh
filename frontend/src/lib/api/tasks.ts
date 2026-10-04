/* =============================================================================
   Task API service
   The only module the UI uses to create, read and cancel tasks.
   ============================================================================= */

import { request, ApiError } from "./client";
import { apiUrl } from "../config";
import { API_ENDPOINTS } from "./endpoints";
import {
  normalizeEvent,
  normalizeTask,
  normalizeTaskList,
} from "./normalize";
import type {
  AgentEvent,
  DataOrigin,
  NewTaskInput,
  TaskRecord,
  TaskStatus,
} from "@/types/domain";
import type { CreateTaskResponse, TaskDetailResponse, TaskDto, TaskFramesDto, TaskListResponse } from "@/types/api";

export interface TaskListParams {
  search?: string;
  status?: TaskStatus | "all";
  sort?: "newest" | "oldest" | "longest" | "shortest";
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export async function createTask(
  input: NewTaskInput,
  signal?: AbortSignal,
): Promise<{ taskId: string; status: TaskStatus; eventsUrl: string | null }> {
  const body: CreateTaskResponse = await request<CreateTaskResponse>(API_ENDPOINTS.tasks, {
    method: "POST",
    body: { prompt: input.prompt, clientRequestId: crypto.randomUUID() },
    signal,
  });

  // Tolerate a bare task object as well as the { taskId } envelope.
  const asDict = body as unknown as Record<string, unknown>;
  const nested = asDict && typeof asDict.task === "object" && asDict.task !== null ? (asDict.task as Record<string, unknown>) : null;
  const taskId =
    (typeof asDict.taskId === "string" && asDict.taskId) ||
    (typeof asDict.task_id === "string" && asDict.task_id) ||
    (typeof asDict.id === "string" && asDict.id) ||
    (nested && typeof nested.id === "string" ? nested.id : null) ||
    (nested && typeof nested.task_id === "string" ? nested.task_id : null);

  if (!taskId) {
    throw new ApiError({
      message: "The service accepted the task but did not return a task id.",
      status: 502,
      url: API_ENDPOINTS.tasks,
    });
  }

  return {
    taskId,
    status: (typeof asDict.status === "string" ? asDict.status : "queued") as TaskStatus,
    eventsUrl: typeof asDict.eventsUrl === "string" ? asDict.eventsUrl : null,
  };
}

export async function fetchTask(taskId: string, origin: DataOrigin, signal?: AbortSignal): Promise<TaskRecord> {
  const dto = await request<TaskDetailResponse>(API_ENDPOINTS.task(taskId), { signal });
  return normalizeTask(dto, origin, taskId);
}

export async function fetchTasks(
  params: TaskListParams,
  origin: DataOrigin,
  signal?: AbortSignal,
): Promise<{ items: TaskRecord[]; total: number; limit: number; offset: number }> {
  const dto = await request<TaskListResponse>(API_ENDPOINTS.tasks, {
    signal,
    query: {
      search: params.search,
      status: params.status && params.status !== "all" ? params.status : undefined,
      sort: params.sort,
      limit: params.limit,
      offset: params.offset,
    },
  });
  return normalizeTaskList(dto, origin);
}

/** Replayable event history for a task. Used when re-opening a report. */
export async function fetchTaskEvents(
  taskId: string,
  origin: DataOrigin,
  signal?: AbortSignal,
): Promise<AgentEvent[]> {
  const raw = await request<unknown>(API_ENDPOINTS.taskEvents(taskId), { signal });
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).events as unknown) ?? ((raw as Record<string, unknown>).items as unknown)
      : [];
  if (!Array.isArray(list)) return [];
  const now = new Date().toISOString();
  return list.map((entry) => normalizeEvent(entry as never, taskId, origin, now));
}

/**
 * Cancel an in-flight task.
 * Returns false when the backend does not expose cancellation (404/405), which
 * the UI surfaces as "stop is not available yet" instead of a fake action.
 */
export async function cancelTask(taskId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request<unknown>(API_ENDPOINTS.taskCancel(taskId), { method: "POST", body: {}, signal });
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return false;
    throw error;
  }
}

export async function fetchTaskFrames(
  taskId: string,
  signal?: AbortSignal,
): Promise<{ framesUrl: string | null; snapshotUrl: string | null }> {
  try {
    // Probe the discovery route purely to learn whether this backend serves
    // frames at all; a 404/405 means "unsupported" and the viewer shows no stream.
    await request<TaskFramesDto>(API_ENDPOINTS.taskFrames(taskId), { signal, timeoutMs: 8_000 });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return { framesUrl: null, snapshotUrl: null };
    }
    throw error;
  }

  // The URLs are built here rather than taken from the discovery response.
  // The backend answers those with absolute URLs rooted at its public base
  // (`AWE_PUBLIC_BASE_URL`, the Tailscale Funnel host), which would send the
  // browser straight off-origin: it bypasses the Next.js proxy entirely, leaks
  // the backend's public hostname to every visitor, and makes local development
  // fail whenever the funnel is down. Deriving them from `taskId` through
  // `apiUrl` keeps the browser same-origin and the proxy the single mapping
  // point, locally and in production alike.
  return {
    framesUrl: apiUrl(API_ENDPOINTS.taskFrameStream(taskId)),
    snapshotUrl: apiUrl(API_ENDPOINTS.taskFrameSnapshot(taskId)),
  };
}

export type { TaskDto };