/* =============================================================================
   TaskReportView
   -----------------------------------------------------------------------------
   Renders a completed task's report: summary, the actions the agent actually
   performed, collected findings, sources and limitations. Every section is
   omitted when the backend returned nothing for it, and the untouched payload
   stays available behind a disclosure so nothing is silently dropped.
   ============================================================================= */

"use client";

import { useMemo } from "react";

import { AnimatedButton } from "@/components/ui/AnimatedButton";
import { Badge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/States";
import { statusMeta } from "@/lib/status";
import { formatDateTime, formatDuration, excerpt, formatRelative, hostnameOf } from "@/lib/utils/format";
import type { TaskReport, TaskRecord } from "@/types/domain";
import {
  AlertIcon,
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  DocumentIcon,
  ExternalLinkIcon,
  LayersIcon,
  ListIcon,
  PlayIcon,
  TargetIcon,
} from "@/components/ui/icons";
import styles from "./TaskReportView.module.css";

export interface TaskReportViewProps {
  task: TaskRecord;
  report: TaskReport | null;
  onRerun?: (prompt: string) => void;
  onOpenFull?: (taskId: string) => void;
}

export function TaskReportView({ task, report, onRerun, onOpenFull }: TaskReportViewProps): React.JSX.Element {
  const meta = statusMeta(task.status);

  return (
    <article className={`bw-panel ${styles.root}`} aria-labelledby="report-heading">
      <header className={styles.head}>
        <div className={styles.headMain}>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <h2 className={styles.title} id="report-heading">
            {task.title}
          </h2>
          <p className={styles.metaLine}>
            <span>{formatRelative(task.createdAt)}</span>
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <span>{formatDuration(task.durationMs)}</span>
            {task.origin === "demo" ? (
              <>
                <span className={styles.dot} aria-hidden="true">
                  ·
                </span>
                <span className={styles.demoTag}>simulated</span>
              </>
            ) : null}
          </p>
        </div>

        <div className={styles.headActions}>
          {onRerun ? (
            <AnimatedButton
              label="Run again"
              size="sm"
              variant="secondary"
              onClick={() => onRerun(task.prompt)}
              icon={<PlayIcon size={14} />}
            />
          ) : null}
          {onOpenFull ? (
            <AnimatedButton
              label="Open details"
              size="sm"
              variant="quiet"
              onClick={() => onOpenFull(task.id)}
              icon={<ArrowLeftIcon size={14} />}
            />
          ) : null}
        </div>
      </header>

      <p className={styles.prompt} title={task.prompt}>
        {task.prompt}
      </p>

      {task.error ? (
        <div className={styles.error} role="alert">
          <span className={styles.errorIcon}>
            <CloseIcon size={14} />
          </span>
          <div>
            <p className={styles.errorTitle}>
              {task.error.code ? `${task.error.code}` : "Task failed"}
            </p>
            <p className={styles.errorBody}>{task.error.message}</p>
            {task.error.retryable ? (
              <p className={styles.errorHint}>The backend marked this error as retryable.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {!report ? (
        <EmptyState
          title="No report for this task"
          icon={<DocumentIcon size={22} />}
          description={
            task.status === "cancelled"
              ? "The task was stopped before it produced a report."
              : "The backend returned no report payload for this run."
          }
        />
      ) : (
        <>
          {report.summary ? (
            <section className={styles.section} aria-label="Summary">
              <h3 className={styles.sectionTitle}>
                <TargetIcon size={14} />
                Summary
              </h3>
              <p className={styles.summary}>{report.summary}</p>
            </section>
          ) : null}

          {report.findings.length ? (
            <section className={styles.section} aria-label="Findings">
              <h3 className={styles.sectionTitle}>
                <LayersIcon size={14} />
                Findings
                <span className={styles.count}>{report.findings.length}</span>
              </h3>
              <ul className={styles.findings}>
                {report.findings.map((finding, index) => (
                  <li className={styles.finding} key={`${finding.label}-${index}`}>
                    <div className={styles.findingMain}>
                      <p className={styles.findingLabel}>{finding.label}</p>
                      <p className={styles.findingValue}>{finding.value}</p>
                      {finding.note ? <p className={styles.findingNote}>{finding.note}</p> : null}
                    </div>
                    {finding.sourceUrl ? (
                      <a
                        className={styles.sourceLink}
                        href={finding.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={finding.sourceUrl}
                      >
                        <ExternalLinkIcon size={12} />
                        {hostnameOf(finding.sourceUrl) ?? "source"}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.actions.length ? (
            <section className={styles.section} aria-label="Actions performed">
              <h3 className={styles.sectionTitle}>
                <ListIcon size={14} />
                Actions performed
                <span className={styles.count}>{report.actions.length}</span>
              </h3>
              <ol className={styles.actions}>
                {report.actions.map((action) => (
                  <li className={styles.action} key={`${action.index}-${action.at}`} data-status={action.status}>
                    <span className={styles.actionIndex}>{String(action.index + 1).padStart(2, "0")}</span>
                    <span className={styles.actionMark} aria-hidden="true">
                      {action.status === "failed" ? <CloseIcon size={12} /> : <CheckIcon size={12} />}
                    </span>
                    <span className={styles.actionMain}>
                      <span className={styles.actionLabel}>{action.label}</span>
                      {action.target ? <span className={styles.actionTarget}>{action.target}</span> : null}
                    </span>
                    {action.url ? (
                      <a
                        className={styles.actionUrl}
                        href={action.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={action.url}
                      >
                        {hostnameOf(action.url) ?? action.url}
                      </a>
                    ) : null}
                    <time className={styles.actionTime} dateTime={action.at} title={formatDateTime(action.at)}>
                      {formatRelative(action.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {report.limitations.length ? (
            <section className={styles.section} aria-label="Limitations">
              <h3 className={styles.sectionTitle}>
                <AlertIcon size={14} />
                Limitations
              </h3>
              <ul className={styles.limitations}>
                {report.limitations.map((limitation, index) => (
                  <li key={`${limitation}-${index}`}>{limitation}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.sources.length ? (
            <section className={styles.section} aria-label="Sources">
              <h3 className={styles.sectionTitle}>
                <ExternalLinkIcon size={14} />
                Sources
                <span className={styles.count}>{report.sources.length}</span>
              </h3>
              <ul className={styles.sources}>
                {report.sources.map((source, index) => (
                  <li key={`${source.url}-${index}`}>
                    <a href={source.url} target="_blank" rel="noopener noreferrer" className={styles.sourceItem}>
                      <span className={styles.sourceDomain}>{source.domain ?? hostnameOf(source.url) ?? source.url}</span>
                      <span className={styles.sourceTitle}>{source.title ?? excerpt(source.url, 60)}</span>
                      {source.accessedAt ? (
                        <span className={styles.sourceTime}>{formatDateTime(source.accessedAt)}</span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.raw !== undefined ? <RawDisclosure raw={report.raw} /> : null}
        </>
      )}
    </article>
  );
}

function RawDisclosure({ raw }: { raw: unknown }): React.JSX.Element {
  const text = useMemo(() => {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }, [raw]);

  return (
    <details className={styles.raw}>
      <summary className={styles.rawSummary}>View raw task payload</summary>
      <pre className={styles.rawPre}>{text}</pre>
    </details>
  );
}