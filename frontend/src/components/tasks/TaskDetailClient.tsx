/* =============================================================================
   TaskDetailClient
   -----------------------------------------------------------------------------
   Loads one task plus its replayable event history and lays it out as: identity
   strip -> report -> events. If the task is still active when the page opens,
   it attaches to the live stream so the view keeps up with the run instead of
   showing a frozen snapshot.
   ============================================================================= */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ActivityFeed } from "@/components/task/ActivityFeed";
import { BrowserViewport } from "@/components/task/BrowserViewport";
import { ProgressIndicator } from "@/components/task/ProgressIndicator";
import { TaskReportView } from "@/components/task/TaskReportView";
import { Badge, StatusBadge } from "@/components/ui/StatusBadge";
import { AnimatedButton } from "@/components/ui/AnimatedButton";
import { ErrorState } from "@/components/ui/States";
import { PanelLoader } from "@/components/ui/States";
import { useDataSource } from "@/lib/data-source";
import { useTaskDetail } from "@/lib/hooks/useQueries";
import type { StreamUpdate } from "@/lib/api/events";
import type { AgentEvent } from "@/types/domain";
import { isTerminalStatus } from "@/types/domain";
import { formatDateTime, formatDuration, pluralize } from "@/lib/utils/format";
import { ArrowLeftIcon, RefreshIcon } from "@/components/ui/icons";
import styles from "./TaskDetailClient.module.css";

export interface TaskDetailClientProps {
  taskId: string;
}

export function TaskDetailClient({ taskId }: TaskDetailClientProps): React.JSX.Element {
  const detail = useTaskDetail(taskId);
  const { isDemo, openStream } = useDataSource();
  const [liveEvents, setLiveEvents] = useState<AgentEvent[] | null>(null);

  /* Attach to the live stream only while the task is still running. */
  useEffect(() => {
    const task = detail.data?.task;
    if (!task || isDemo || isTerminalStatus(task.status)) return;
    if (!taskId) return;

    const session = openStream(taskId, task.prompt, (update: StreamUpdate) => {
      if (update.kind === "event") {
        setLiveEvents((current) => {
          const base = current ?? detail.data?.events ?? [];
          if (base.some((event) => event.id === update.event.id)) return base;
          return [...base, update.event];
        });
      }
    });
    session.start();
    return () => session.close();
    // Intentionally keyed on the run's terminal state, not on every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.task.id, detail.data?.task.status, isDemo, openStream]);

  const events = liveEvents ?? detail.data?.events ?? [];
  const reload = detail.reload;

  if (detail.loading && !detail.data) {
    return (
      <div className={`bw-panel ${styles.panel}`}>
        <PanelLoader label="Loading task" variant="panel" />
      </div>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <div className={`bw-panel ${styles.panel}`}>
        <ErrorState
          title="This task could not be loaded"
          message={detail.error ?? "The backend returned no task for that id."}
          onRetry={reload}
          retryLabel="Try again"
        />
        <p className={styles.backNote}>
          <Link className={styles.backLink} href="/tasks">
            <ArrowLeftIcon size={13} />
            Back to task history
          </Link>
        </p>
      </div>
    );
  }

  const { task } = detail.data;
  const running = !isTerminalStatus(task.status);
  const startedAt = task.startedAt ?? task.createdAt;
  const endedAt = task.completedAt;
  const elapsed = Date.parse(endedAt ?? new Date().toISOString()) - Date.parse(startedAt);

  return (
    <div className={styles.root}>
      <section className={`bw-panel ${styles.identity}`} aria-label="Task summary">
        <div className={styles.identityMain}>
          <div className={styles.identityHead}>
            <StatusBadge status={task.status} />
            {task.origin === "demo" ? <Badge tone="warning">Simulated</Badge> : null}
            {running ? <Badge tone="active">Live</Badge> : null}
          </div>
          <h2 className={styles.identityTitle}>{task.title}</h2>
          <p className={styles.identityPrompt}>{task.prompt}</p>
        </div>

        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Task id</dt>
            <dd className="bw-mono">{task.id}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Created</dt>
            <dd title={formatDateTime(task.createdAt)}>{formatDateTime(task.createdAt)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Duration</dt>
            <dd>{task.durationMs ? formatDuration(task.durationMs) : running ? "in progress" : "—"}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Events</dt>
            <dd>{events.length ? `${events.length} ${pluralize(events.length, "event")}` : "none recorded"}</dd>
          </div>
        </dl>

        <div className={styles.identityActions}>
          <AnimatedButton label="Reload" size="sm" variant="quiet" onClick={reload} icon={<RefreshIcon size={13} />} />
          <AnimatedButton
            label="Run again"
            size="sm"
            variant="secondary"
            onClick={() => {
              window.location.href = `/?prompt=${encodeURIComponent(task.prompt)}`;
            }}
            disabled={running}
          />
        </div>
      </section>

      {running ? (
        <section className={`bw-panel ${styles.live}`} aria-label="Live progress">
          <ProgressIndicator task={task} now={Date.now()} />
          <p className={styles.liveNote}>
            This task is still running, so the view is attached to its live stream.{" "}
            {Number.isFinite(elapsed) ? `${formatDuration(elapsed)} elapsed so far.` : ""}
          </p>
        </section>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.col}>
          <TaskReportView task={task} report={task.report ?? null} />
        </div>

        <div className={styles.col}>
          <section className={`bw-panel ${styles.panel}`} aria-label="Browser activity">
            <BrowserViewport task={task} taskId={task.id} running={running} />
          </section>

          <section className={`bw-panel ${styles.panel}`} aria-label="Event history">
            <ActivityFeed events={events} waiting={running && events.length === 0} />
          </section>
        </div>
      </div>

      <p className={styles.backRow}>
        <Link className={styles.backLink} href="/tasks">
          <ArrowLeftIcon size={13} />
          Back to task history
        </Link>
      </p>
    </div>
  );
}