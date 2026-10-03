/* =============================================================================
   AnalyticsClient
   -----------------------------------------------------------------------------
   Reads the real stats payload from the active source and plots it. Every panel
   says where the numbers came from; in demo mode the fixtures are labelled
   rather than presented as recorded history.

   The recent-runs list is taken from the same stats response, so the charts and
   the table can never disagree.
   ============================================================================= */

"use client";

import Link from "next/link";

import { BarChart } from "@/components/charts/BarChart";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { MetricCard } from "@/components/charts/MetricCard";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { Badge, StatusBadge } from "@/components/ui/StatusBadge";
import { ErrorState } from "@/components/ui/States";
import { PanelLoader } from "@/components/ui/States";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { useDataSource } from "@/lib/data-source";
import { useStats } from "@/lib/hooks/useQueries";
import { formatCompactNumber, formatDayLabel, formatDuration, formatRelative } from "@/lib/utils/format";
import type { StatsRange } from "@/types/domain";
import { ArrowRightIcon, ClockIcon } from "@/components/ui/icons";
import styles from "./AnalyticsClient.module.css";

const RANGES: { value: StatsRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

/** Series colours come from the approved ramp, read from CSS at runtime. */
const COLORS = {
  performed: "var(--bw-cycle-1)",
  completed: "var(--bw-cycle-3)",
  failed: "var(--bw-danger)",
  cancelled: "var(--bw-ink-600)",
  duration: "var(--bw-cycle-4)",
} as const;

export function AnalyticsClient(): React.JSX.Element {
  const stats = useStats();
  const { isDemo, reason } = useDataSource();

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <div className={styles.ranges} role="group" aria-label="Select time range">
          {RANGES.map((range) => {
            const active = stats.range === range.value;
            return (
              <button
                key={range.value}
                type="button"
                className={styles.range}
                data-active={active || undefined}
                aria-pressed={active}
                onClick={() => stats.setRange(range.value)}
              >
                {range.label}
              </button>
            );
          })}
        </div>
        {stats.data ? (
          <Badge tone={stats.data.origin === "demo" ? "warning" : "success"}>
            {stats.data.origin === "demo" ? "Demo fixtures" : "Backend data"}
          </Badge>
        ) : null}
      </div>

      {stats.loading ? (
        <div className={`bw-panel ${styles.panel}`}>
          <PanelLoader label="Loading analytics" variant="panel" />
        </div>
      ) : stats.error ? (
        <div className={`bw-panel ${styles.panel}`}>
          <ErrorState
            title="Analytics could not be loaded"
            message={stats.error}
            onRetry={stats.reload}
            retryLabel="Reload"
          />
        </div>
      ) : stats.data ? (
        <>
          <Reveal>
            <div className={styles.metricGrid}>
              <MetricCard
                label="Total tasks"
                value={stats.data.totalTasks}
                format={(value) => formatCompactNumber(value)}
                hint={`over ${RANGES.find((r) => r.value === stats.range)?.label ?? stats.range}`}
                isDemo={stats.data.origin === "demo"}
              />
              <MetricCard
                label="Completed"
                value={stats.data.completedTasks}
                format={(value) => formatCompactNumber(value)}
                hint="finished with a report"
                tone="success"
                isDemo={stats.data.origin === "demo"}
                delay={60}
              />
              <MetricCard
                label="Failed"
                value={stats.data.failedTasks}
                format={(value) => formatCompactNumber(value)}
                hint="returned an error"
                tone="danger"
                isDemo={stats.data.origin === "demo"}
                delay={120}
              />
              <MetricCard
                label="Average duration"
                value={stats.data.averageDurationMs}
                format={(value) => formatDuration(value)}
                hint="across finished runs"
                isDemo={stats.data.origin === "demo"}
                delay={180}
              />
            </div>
          </Reveal>

          <div className={styles.chartGrid}>
            <Reveal className={styles.chart}>
              <ChartFrame
                title="Task volume"
                description="How many tasks were started per day, and how many finished."
                isDemo={stats.data.origin === "demo"}
                legend={[
                  { label: "Performed", color: COLORS.performed, variant: "line" },
                  { label: "Completed", color: COLORS.completed, variant: "line" },
                  { label: "Failed", color: COLORS.failed, variant: "line" },
                ]}
                empty={stats.data.buckets.length === 0}
                emptyMessage="No activity in this range."
              >
                <TimeSeriesChart
                  labels={stats.data.buckets.map((bucket) => formatDayLabel(bucket.date))}
                  series={[
                    { key: "performed", label: "Performed", color: COLORS.performed, values: stats.data.buckets.map((b) => b.performed), area: true },
                    { key: "completed", label: "Completed", color: COLORS.completed, values: stats.data.buckets.map((b) => b.completed) },
                    { key: "failed", label: "Failed", color: COLORS.failed, values: stats.data.buckets.map((b) => b.failed) },
                  ]}
                  height={240}
                  formatValue={(value) => formatCompactNumber(value)}
                />
              </ChartFrame>
            </Reveal>

            <Reveal delay={80} className={styles.chart}>
              <ChartFrame
                title="Duration trend"
                description="Average time to finish a task, per day. Days without a finished task are left blank."
                isDemo={stats.data.origin === "demo"}
                empty={stats.data.buckets.every((bucket) => bucket.durationMs === null)}
                emptyMessage="No finished tasks to measure in this range."
              >
                <TimeSeriesChart
                  labels={stats.data.buckets.map((bucket) => formatDayLabel(bucket.date))}
                  series={[
                    {
                      key: "duration",
                      label: "Average duration",
                      color: COLORS.duration,
                      values: stats.data.buckets.map((bucket) => (bucket.durationMs === null ? null : bucket.durationMs / 1000)),
                      area: true,
                    },
                  ]}
                  height={240}
                  formatValue={(value) => `${Math.round(value)}s`}
                  showDots={false}
                />
              </ChartFrame>
            </Reveal>
          </div>

          <Reveal delay={60}>
            <ChartFrame
              title="Outcome mix"
              description="Completed, failed and stopped tasks per day."
              isDemo={stats.data.origin === "demo"}
              legend={[
                { label: "Completed", color: COLORS.completed, variant: "swatch" },
                { label: "Failed", color: COLORS.failed, variant: "swatch" },
                { label: "Cancelled", color: COLORS.cancelled, variant: "swatch" },
              ]}
              empty={stats.data.buckets.length === 0}
              emptyMessage="No activity in this range."
            >
              <BarChart
                labels={stats.data.buckets.map((bucket) => formatDayLabel(bucket.date))}
                series={[
                  { key: "completed", label: "Completed", color: COLORS.completed, values: stats.data.buckets.map((b) => b.completed) },
                  { key: "failed", label: "Failed", color: COLORS.failed, values: stats.data.buckets.map((b) => b.failed) },
                  { key: "cancelled", label: "Cancelled", color: COLORS.cancelled, values: stats.data.buckets.map((b) => b.cancelled) },
                ]}
                height={220}
                showValues={stats.data.buckets.length <= 10}
              />
            </ChartFrame>
          </Reveal>

          <section className={styles.recent}>
            <SectionHeading
              eyebrow="Latest"
              title="Recent runs"
              description="The most recent tasks in this range, straight from the stats payload."
            />
            {stats.data.recent.length === 0 ? (
              <p className={styles.recentEmpty}>No runs recorded in this range.</p>
            ) : (
              <ul className={styles.recentList}>
                {stats.data.recent.map((task, index) => (
                  <li key={task.id} style={{ animationDelay: `${Math.min(index, 10) * 24}ms` }}>
                    <Link className={styles.recentRow} href={`/tasks/${task.id}`}>
                      <div className={styles.recentMain}>
                        <div className={styles.recentHead}>
                          <StatusBadge status={task.status} size="sm" />
                          {task.origin === "demo" ? <Badge tone="warning">Simulated</Badge> : null}
                        </div>
                        <p className={styles.recentTitle}>{task.title}</p>
                      </div>
                      <p className={styles.recentMeta}>
                        <span>{formatRelative(task.createdAt)}</span>
                        <span className={styles.recentDuration}>
                          <ClockIcon size={11} />
                          {task.durationMs ? formatDuration(task.durationMs) : "—"}
                        </span>
                        <span className={styles.recentReport}>
                          {task.report ? "Report" : "No report"}
                        </span>
                      </p>
                      <ArrowRightIcon size={14} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {isDemo && reason ? <p className={styles.disclaimer}>{reason}</p> : null}
        </>
      ) : null}
    </div>
  );
}