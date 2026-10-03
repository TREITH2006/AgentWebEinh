/* =============================================================================
   Task detail route
   -----------------------------------------------------------------------------
   Reads the id from the URL, renders the task server-agnostically and lets
   TaskDetailClient load the record, its report and its event history.
   ============================================================================= */

import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";
import { TaskDetailClient } from "@/components/tasks/TaskDetailClient";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Task detail",
  description: "A single agent run: status, report, actions performed and full event history.",
};

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}): Promise<React.JSX.Element> {
  const { taskId } = await params;

  return (
    <div className="bw-shell">
      <PageHeader eyebrow="Task" title="Task detail" lede="One run, end to end: what was asked, what happened, and what came back.">
        <p className={styles.idLine}>Task id: <span className="bw-mono">{taskId}</span></p>
      </PageHeader>
      <TaskDetailClient taskId={taskId} />
    </div>
  );
}