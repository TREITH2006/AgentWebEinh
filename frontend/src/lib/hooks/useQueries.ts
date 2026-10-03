/* =============================================================================
   Data hooks: task history, task detail, performance statistics
   All three share the same loading / error / empty contract so every list and
   panel in the product behaves consistently.
   ============================================================================= */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_CONFIG } from "@/lib/config";
import { useDataSource } from "@/lib/data-source";
import { matchesStatusFilter, type StatusFilter } from "@/lib/status";
import type { AgentEvent, StatsRange, TaskRecord, TaskStats } from "@/types/domain";
import type { TaskStatus } from "@/types/domain";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/* ----------------------------------------------------------- task history -- */

export interface TaskHistoryFilters {
  search: string;
  /** Grouped filter; several groups cannot be expressed as a single API status. */
  status: StatusFilter;
  sort: "newest" | "oldest" | "longest" | "shortest";
}

/** Only one group maps cleanly onto a single backend status filter. */
function toApiStatus(filter: StatusFilter): TaskStatus | "all" | undefined {
  switch (filter) {
    case "completed":
      return "completed";
    case "all":
      return "all";
    default:
      // "active" and "failed" are groups of several statuses; the client-side
      // pass below is authoritative so a backend that ignores the parameter
      // still produces a correct list.
      return undefined;
  }
}

export interface TaskHistoryResult extends AsyncState<{ items: TaskRecord[]; total: number }> {
  filters: TaskHistoryFilters;
  setFilters: (next: Partial<TaskHistoryFilters>) => void;
  isEmpty: boolean;
  /** Client-side filtering of the returned page. */
  visible: TaskRecord[];
}

export function useTaskHistory(): TaskHistoryResult {
  const { service, status } = useDataSource();
  const [filters, setFiltersState] = useState<TaskHistoryFilters>({
    search: "",
    status: "all",
    sort: "newest",
  });
  const [items, setItems] = useState<TaskRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (status === "checking") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void service
      .listTasks(
        {
          search: filters.search,
          status: toApiStatus(filters.status),
          sort: filters.sort,
          limit: API_CONFIG.historyPageSize,
          offset: 0,
        },
        controller.signal,
      )
      .then((page) => {
        if (!mounted.current || controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || controller.signal.aborted || isAbort(cause)) return;
        setError(cause instanceof Error ? cause.message : "Task history could not be loaded.");
        setItems([]);
        setTotal(0);
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [service, status, filters.search, filters.status, filters.sort, nonce]);

  const setFilters = useCallback((next: Partial<TaskHistoryFilters>) => {
    setFiltersState((current) => ({ ...current, ...next }));
  }, []);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  // The API already filters and sorts; this pass keeps the UI correct for backends
  // that ignore those parameters.
  const visible = useMemo(() => {
    let result = items;
    if (filters.search.trim()) {
      const needle = filters.search.trim().toLowerCase();
      result = result.filter(
        (task) =>
          task.title.toLowerCase().includes(needle) ||
          task.prompt.toLowerCase().includes(needle) ||
          task.id.toLowerCase().includes(needle),
      );
    }
    if (filters.status !== "all") {
      result = result.filter((task) => matchesStatusFilter(task.status, filters.status));
    }
    return result;
  }, [items, filters.search, filters.status]);

  return {
    data: { items: visible, total },
    loading,
    error,
    reload,
    filters,
    setFilters,
    isEmpty: !loading && !error && visible.length === 0,
    visible,
  };
}

/* ------------------------------------------------------------ task detail -- */

export interface TaskDetailResult extends AsyncState<{ task: TaskRecord; events: AgentEvent[] }> {}

/** Loads a single task and its replayable event history. */
export function useTaskDetail(taskId: string | null): TaskDetailResult {
  const { service, status } = useDataSource();
  const [data, setData] = useState<{ task: TaskRecord; events: AgentEvent[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!taskId || status === "checking") {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void (async () => {
      const task = await service.getTask(taskId, controller.signal);
      let events: AgentEvent[] = [];
      try {
        events = await service.getTaskEvents(taskId, controller.signal);
      } catch {
        events = [];
      }
      return { task, events };
    })()
      .then((result) => {
        if (!mounted.current || controller.signal.aborted) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || controller.signal.aborted || isAbort(cause)) return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "That task could not be loaded.");
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [service, status, taskId, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, loading, error, reload };
}

/* ------------------------------------------------------------------ stats -- */

export interface StatsResult extends AsyncState<TaskStats> {
  range: StatsRange;
  setRange: (range: StatsRange) => void;
}

export function useStats(): StatsResult {
  const { service, status } = useDataSource();
  const [range, setRange] = useState<StatsRange>("30d");
  const [data, setData] = useState<TaskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (status === "checking") return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void service
      .getStats(range, controller.signal)
      .then((result) => {
        if (!mounted.current || controller.signal.aborted) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || controller.signal.aborted || isAbort(cause)) return;
        setData(null);
        setError(cause instanceof Error ? cause.message : "Performance statistics could not be loaded.");
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [service, status, range, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, loading, error, reload, range, setRange };
}