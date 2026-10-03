/* =============================================================================
   DashboardClient
   -----------------------------------------------------------------------------
   The dashboard's interactive half. Holds exactly one run at a time and hands
   the same task record to the workspace and the report so the two can never
   disagree about what happened.

   The metric strip is real data from the active source (the backend in live
   mode, fixtures in demo mode) and is labelled with the origin, never implied
   to be live when it is not.
   ============================================================================= */

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";

import { Reveal } from "@/components/ui/Reveal";
import { BanterLoader } from "@/components/ui/BanterLoader";
import { Badge } from "@/components/ui/StatusBadge";
import { MetricCard } from "@/components/charts/MetricCard";
import { useDataSource } from "@/lib/data-source";
import { useStats } from "@/lib/hooks/useQueries";
import { useTaskRunner } from "@/lib/hooks/useTaskRunner";
import { formatCompactNumber, formatPercent } from "@/lib/utils/format";
import { ExecutionWorkspace } from "@/components/task/ExecutionWorkspace";
import { TaskComposer } from "@/components/task/TaskComposer";
import { TaskReportView } from "@/components/task/TaskReportView";
import styles from "./DashboardClient.module.css";

export function DashboardClient(): React.JSX.Element {
  const router = useRouter();
  const { isDemo, reason } = useDataSource();
  const runner = useTaskRunner();
  const stats = useStats();
  const startRef = useRef<HTMLDivElement | null>(null);

  const { phase, task, events, transport, transportNote, error, cancelState, canCancel, start, stop, reset } = runner;

  const handleStart = useCallback(
    (prompt: string) => {
      void start(prompt);
      // Bring the run into view without yanking the page on small screens.
      if (typeof window !== "undefined" && window.matchMedia("(min-width: 900px)").matches) {
        window.requestAnimationFrame(() => startRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    },
    [start],
  );

  const showWorkspace = phase !== "idle" && task !== null;
  const showReport = phase === "settled" && task !== null;

  return (
    <>
      <section className={styles.metrics} aria-label="Workspace metrics">
        {stats.loading ? (
          <div className={styles.metricsLoading}>
            <BanterLoader label="Loading metrics" size="sm" />
          </div>
        ) : stats.data ? (
          <Reveal>
            <div className={styles.metricGrid}>
              <MetricCard
                label="Tasks recorded"
                value={stats.data.totalTasks}
                format={(value) => formatCompactNumber(value)}
                hint={stats.data.origin === "demo" ? "from demo fixtures" : `over ${stats.range}`}
                isDemo={stats.data.origin === "demo"}
                delay={0}
              />
              <MetricCard
                label="Success rate"
                value={stats.data.successRate}
                format={(value) => formatPercent(value, 0)}
                hint={`${formatCompactNumber(stats.data.completedTasks)} completed`}
                tone="success"
                isDemo={stats.data.origin === "demo"}
                delay={60}
              />
              <MetricCard
                label="Average duration"
                value={stats.data.averageDurationMs}
                format={(value) => `${Math.round(value / 1000)}s`}
                hint="per recorded run"
                isDemo={stats.data.origin === "demo"}
                delay={120}
              />
              <MetricCard
                label="Failed or stopped"
                value={stats.data.failedTasks + stats.data.cancelledTasks}
                hint={`${stats.data.failedTasks} failed · ${stats.data.cancelledTasks} stopped`}
                tone="danger"
                isDemo={stats.data.origin === "demo"}
                delay={180}
              />
            </div>
            {isDemo && reason ? <p className={styles.metricNote}>{reason}</p> : null}
          </Reveal>
        ) : stats.error ? (
          <p className={styles.metricError} role="status">
            Metrics are unavailable: {stats.error}
          </p>
        ) : null}
      </section>

      <Reveal delay={80}>
        <TaskComposer
          onSubmit={handleStart}
          submitting={phase === "submitting"}
          busy={phase === "active"}
          error={error}
        />
      </Reveal>

      <div ref={startRef} className={styles.anchor}>
        {showWorkspace ? (
          <ExecutionWorkspace
            task={task}
            events={events}
            transport={transport}
            transportNote={transportNote}
            cancelState={cancelState}
            canCancel={canCancel}
            onStop={() => void stop()}
            onReset={reset}
          />
        ) : null}

        {phase === "submitting" && !task ? (
          <section className={`bw-panel ${styles.pending}`} aria-live="polite">
            <BanterLoader label="Submitting your task" size="md" />
            <p className={styles.pendingHint}>The agent will start reporting as soon as it is accepted.</p>
          </section>
        ) : null}

        {showReport ? (
          <>
            <div className={styles.settledHead}>
              <Badge tone={task.status === "completed" ? "success" : task.status === "cancelled" ? "idle" : "danger"}>
                {task.status === "completed" ? "Run finished" : task.status === "cancelled" ? "Run stopped" : "Run failed"}
              </Badge>
              <button type="button" className={styles.detailLink} onClick={() => router.push(`/tasks/${task.id}`)}>
                Open full task page
              </button>
            </div>
            <TaskReportView task={task} report={task.report ?? null} onRerun={handleStart} />
          </>
        ) : null}
      </div>
    </>
  );
}