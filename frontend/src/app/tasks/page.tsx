/* =============================================================================
   Task history page
   -----------------------------------------------------------------------------
   Server shell. TaskListClient owns the search field, status filter, sort order
   and the list itself.
   ============================================================================= */

import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";
import { TaskListClient } from "@/components/tasks/TaskListClient";

export const metadata: Metadata = {
  title: "Task history",
  description: "Every task the agent has run, with its status, duration and report.",
};

export default function TasksPage(): React.JSX.Element {
  return (
    <div className="bw-shell">
      <PageHeader
        eyebrow="History"
        title="Task history"
        lede="Search past runs, filter by state, and open any task to read its full report and event stream."
      />
      <TaskListClient />
    </div>
  );
}