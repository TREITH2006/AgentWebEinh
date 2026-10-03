/* =============================================================================
   TaskListClient
   -----------------------------------------------------------------------------
   Search, filter and sort over the task history. Each row is a real record from
   the active source: status badge, relative time, measured duration and whether
   a report came back with it. Demo rows are tagged so they are never confused
   with recorded runs.
   ============================================================================= */

"use client";

import Link from "next/link";
import { useDeferredValue } from "react";

import { Badge, StatusBadge } from "@/components/ui/StatusBadge";
import { ErrorState, EmptyState, SkeletonRows } from "@/components/ui/States";
import { SearchField } from "@/components/ui/SearchField";
import { AnimatedButton } from "@/components/ui/AnimatedButton";
import { STATUS_FILTERS, statusMeta } from "@/lib/status";
import { useTaskHistory } from "@/lib/hooks/useQueries";
import { formatDateTime, formatDuration, formatRelative, pluralize } from "@/lib/utils/format";
import type { TaskRecord } from "@/types/domain";
import { ArrowRightIcon, ClockIcon, DocumentIcon, RefreshIcon, SearchIcon } from "@/components/ui/icons";
import styles from "./TaskListClient.module.css";

const SORTS: { value: "newest" | "oldest" | "longest" | "shortest"; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "longest", label: "Longest run" },
  { value: "shortest", label: "Shortest run" },
];

export function TaskListClient(): React.JSX.Element {
  const history = useTaskHistory();
  const deferredSearch = useDeferredValue(history.filters.search);
  const { filters, setFilters } = history;

  const visible = history.visible.slice().sort(sortTasks(filters.sort));

  const hasFilters = Boolean(filters.search.trim()) || filters.status !== "all" || filters.sort !== "newest";

  return (
    <div className={styles.root}>
      <div className={`bw-panel ${styles.toolbar}`}>
        <SearchField
          value={filters.search}
          onChange={(value) => setFilters({ search: value })}
          placeholder="Search by task, prompt or id…"
          label="Search tasks"
        />

        <div className={styles.filterRow}>
          <div className={styles.chips} role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((option) => {
              const active = filters.status === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={styles.chip}
                  data-active={active || undefined}
                  aria-pressed={active}
                  onClick={() => setFilters({ status: option.value })}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <label className={styles.sort}>
            <span className={styles.sortLabel}>Sort</span>
            <select
              className={styles.select}
              value={filters.sort}
              onChange={(event) => setFilters({ sort: event.target.value as typeof filters.sort })}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <AnimatedButton
            label="Refresh"
            size="sm"
            variant="quiet"
            onClick={history.reload}
            icon={<RefreshIcon size={13} />}
          />
        </div>
      </div>

      <div className={styles.summaryRow} aria-live="polite">
        <p className={styles.summary}>
          {history.loading
            ? "Loading tasks…"
            : `Showing ${visible.length} of ${history.data?.total ?? 0} ${pluralize(history.data?.total ?? 0, "task")}`}
        </p>
        {hasFilters ? (
          <button
            type="button"
            className={styles.clearFilters}
            onClick={() => setFilters({ search: "", status: "all", sort: "newest" })}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {history.loading ? (
        <div className={`bw-panel ${styles.listPanel}`}>
          <SkeletonRows rows={6} />
        </div>
      ) : history.error ? (
        <div className={`bw-panel ${styles.listPanel}`}>
          <ErrorState
            title="Task history could not be loaded"
            message={history.error}
            onRetry={history.reload}
            retryLabel="Try again"
          />
        </div>
      ) : visible.length === 0 ? (
        <div className={`bw-panel ${styles.listPanel}`}>
          <EmptyState
            title={hasFilters ? "No tasks match those filters" : "No tasks yet"}
            icon={<SearchIcon size={22} />}
            description={
              hasFilters
                ? "Try a different search term or clear the status filter."
                : "Run a task from the dashboard and it will appear here with its full report."
            }
            action={
              hasFilters ? (
                <AnimatedButton
                  label="Clear filters"
                  size="sm"
                  variant="secondary"
                  onClick={() => setFilters({ search: "", status: "all", sort: "newest" })}
                />
              ) : (
                <Link className={styles.cta} href="/">
                  Go to the dashboard
                  <ArrowRightIcon size={13} />
                </Link>
              )
            }
          />
        </div>
      ) : (
        <ul className={styles.list}>
          {visible.map((task, index) => (
            <TaskRow key={task.id} task={task} index={index} />
          ))}
        </ul>
      )}

      {deferredSearch !== filters.search ? <p className="bw-sr-only" role="status">Filtering</p> : null}
    </div>
  );
}

function sortTasks(order: "newest" | "oldest" | "longest" | "shortest") {
  return (a: TaskRecord, b: TaskRecord): number => {
    switch (order) {
      case "oldest":
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      case "longest":
        return (b.durationMs ?? 0) - (a.durationMs ?? 0);
      case "shortest":
        return (a.durationMs ?? 0) - (b.durationMs ?? 0);
      case "newest":
      default:
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }
  };
}

function TaskRow({ task, index }: { task: TaskRecord; index: number }): React.JSX.Element {
  const meta = statusMeta(task.status);
  const findings = task.report?.findings.length ?? 0;

  return (
    <li style={{ animationDelay: `${Math.min(index, 10) * 26}ms` }}>
      <Link className={styles.row} href={`/tasks/${task.id}`}>
        <div className={styles.rowMain}>
          <div className={styles.rowHead}>
            <StatusBadge status={task.status} size="sm" />
            {task.origin === "demo" ? <Badge tone="warning">Simulated</Badge> : null}
            {task.report ? (
              <Badge tone="neutral" icon={<DocumentIcon size={11} />}>
                {findings ? `${findings} ${pluralize(findings, "finding")}` : "Report"}
              </Badge>
            ) : null}
          </div>
          <p className={styles.rowTitle}>{task.title}</p>
          <p className={styles.rowPrompt}>{task.prompt}</p>
        </div>

        <div className={styles.rowMeta}>
          <p className={styles.rowTime} title={formatDateTime(task.createdAt)}>
            {formatRelative(task.createdAt)}
          </p>
          <p className={styles.rowDuration}>
            <ClockIcon size={11} />
            {task.durationMs ? formatDuration(task.durationMs) : "—"}
          </p>
          <p className={styles.rowState}>{meta.label}</p>
        </div>

        <span className={styles.rowArrow} aria-hidden="true">
          <ArrowRightIcon size={15} />
        </span>
      </Link>
    </li>
  );
}