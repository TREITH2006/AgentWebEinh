/* =============================================================================
   ProgressIndicator
   -----------------------------------------------------------------------------
   Two distinct behaviours, deliberately not conflated:

     - `progress` is a number: a real ratio, rendered as a real bar.
     - `progress` is null: the backend reported no percentage. We show an
       indeterminate sweep and say so, instead of inventing a number.

   Elapsed time is always real wall-clock time derived from the task timestamps.
   ============================================================================= */

"use client";

import { StatusBadge } from "@/components/ui/StatusBadge";
import { statusMeta } from "@/lib/status";
import { formatDuration, formatRelative } from "@/lib/utils/format";
import type { TaskRecord } from "@/types/domain";
import styles from "./ProgressIndicator.module.css";

export interface ProgressIndicatorProps {
  task: TaskRecord;
  /** Live client clock so elapsed time advances while a task runs. */
  now: number;
}

const ACTIVE = new Set<TaskRecord["status"]>(["queued", "starting", "running", "awaiting_approval"]);

export function ProgressIndicator({ task, now }: ProgressIndicatorProps): React.JSX.Element {
  const meta = statusMeta(task.status);
  const isActive = ACTIVE.has(task.status);
  const startedAt = task.startedAt ?? task.createdAt;
  const endedAt = task.completedAt;
  const elapsed = Date.parse(endedAt ?? new Date(now).toISOString()) - Date.parse(startedAt);
  const reported = task.progress ?? null;
  const indeterminate = reported === null;
  const ratio = indeterminate ? null : Math.max(0, Math.min(1, reported));

  return (
    <div className={styles.root} data-active={isActive || undefined}>
      <div className={styles.head}>
        <StatusBadge status={task.status} size="sm" />
        <p className={styles.activity} title={task.currentActivity ?? undefined}>
          {task.currentActivity ?? meta.description}
        </p>
        <p className={styles.timing}>
          <span className={styles.elapsed}>{formatDuration(Number.isFinite(elapsed) ? elapsed : null)}</span>
          <span className={styles.timingLabel}>
            {endedAt ? "total" : isActive ? "elapsed" : "recorded"}
          </span>
        </p>
      </div>

      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round((ratio ?? 0) * 100)}
        aria-label={indeterminate ? "Progress not reported by the backend" : "Task progress"}
      >
        <span
          className={styles.fill}
          data-indeterminate={indeterminate || undefined}
          data-tone={meta.tone}
          style={indeterminate ? undefined : { transform: `scaleX(${ratio})` }}
        />
      </div>

      <p className={styles.note}>
        {indeterminate ? (
          <>
            Progress is not reported for this task
            {isActive ? " while it runs" : ""}. Follow the activity feed for detail.
          </>
        ) : (
          <>
            {Math.round((ratio ?? 0) * 100)}% reported
            {task.startedAt ? ` · started ${formatRelative(task.startedAt)}` : ""}
          </>
        )}
      </p>
    </div>
  );
}