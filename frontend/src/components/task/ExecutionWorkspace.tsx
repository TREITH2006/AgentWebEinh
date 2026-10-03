/* =============================================================================
   ExecutionWorkspace
   -----------------------------------------------------------------------------
   Appears once a task exists. Owns the run header (status, transport, stop
   control), the honest progress indicator, the browser surface and the activity
   feed. It renders nothing at all when there is no task, so the dashboard can
   hand over layout cleanly.
   ============================================================================= */

"use client";

import { useEffect, useState } from "react";

import { AnimatedButton } from "@/components/ui/AnimatedButton";
import { Badge } from "@/components/ui/StatusBadge";
import type { StreamTransport } from "@/lib/api/events";
import type { CancelState } from "@/lib/hooks/useTaskRunner";
import { statusMeta } from "@/lib/status";
import { formatRelative, pluralize } from "@/lib/utils/format";
import type { AgentEvent, TaskRecord } from "@/types/domain";
import { isTerminalStatus } from "@/types/domain";
import { RefreshIcon, StopIcon } from "@/components/ui/icons";
import { ActivityFeed } from "./ActivityFeed";
import { BrowserViewport } from "./BrowserViewport";
import { ProgressIndicator } from "./ProgressIndicator";
import styles from "./ExecutionWorkspace.module.css";

const TRANSPORT_LABEL: Record<StreamTransport, { label: string; tone: "success" | "warning" | "idle" }> = {
  websocket: { label: "WebSocket", tone: "success" },
  polling: { label: "Polling fallback", tone: "warning" },
  closed: { label: "Stream closed", tone: "idle" },
};

export interface ExecutionWorkspaceProps {
  task: TaskRecord;
  events: AgentEvent[];
  transport: StreamTransport;
  transportNote: string | null;
  cancelState: CancelState;
  canCancel: boolean;
  onStop: () => void;
  onReset: () => void;
}

export function ExecutionWorkspace({
  task,
  events,
  transport,
  transportNote,
  cancelState,
  canCancel,
  onStop,
  onReset,
}: ExecutionWorkspaceProps): React.JSX.Element {
  /* One clock for the whole workspace so the elapsed readout ticks smoothly. */
  const [now, setNow] = useState(() => Date.now());
  const running = !isTerminalStatus(task.status);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  const meta = statusMeta(task.status);
  const transportInfo = TRANSPORT_LABEL[transport];
  const waiting = events.length === 0 && running;

  return (
    <section className={`bw-panel ${styles.root}`} aria-labelledby="workspace-heading" aria-busy={running || undefined}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h2 className={styles.title} id="workspace-heading">
            Execution workspace
          </h2>
          <p className={styles.sub}>
            {meta.description} · started {formatRelative(task.startedAt ?? task.createdAt)}
            {events.length ? ` · ${events.length} ${pluralize(events.length, "event")}` : ""}
          </p>
        </div>

        <div className={styles.headControls}>
          <Badge tone={transportInfo.tone} title={transportNote ?? undefined}>
            {transportInfo.label}
          </Badge>
          {canCancel ? (
            <AnimatedButton
              label={cancelState === "cancelling" ? "Stopping" : "Stop task"}
              size="sm"
              variant="danger"
              loading={cancelState === "cancelling"}
              loadingText="Stopping"
              onClick={onStop}
              icon={cancelState === "cancelling" ? undefined : <StopIcon size={13} />}
            />
          ) : (
            <AnimatedButton label="Clear run" size="sm" variant="quiet" onClick={onReset} icon={<RefreshIcon size={13} />} />
          )}
        </div>
      </header>

      {transportNote ? <p className={styles.note}>{transportNote}</p> : null}
      {cancelState === "stopped" ? (
        <p className={styles.note} data-tone="ok">
          Stop requested. The backend will settle the task shortly.
        </p>
      ) : null}
      {cancelState === "unsupported" ? (
        <p className={styles.note} data-tone="warn">
          This backend exposes no cancellation route, so the task cannot be stopped from the dashboard.
        </p>
      ) : null}

      <ProgressIndicator task={task} now={now} />

      <div className={styles.grid}>
        <div className={styles.viewportCol}>
          <BrowserViewport task={task} taskId={task.id} running={running} />
        </div>
        <div className={styles.feedCol}>
          <ActivityFeed events={events} waiting={waiting} />
        </div>
      </div>
    </section>
  );
}