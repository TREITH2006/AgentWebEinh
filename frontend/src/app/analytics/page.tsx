/* =============================================================================
   Analytics route
   -----------------------------------------------------------------------------
   Server shell; AnalyticsClient owns the range switch, the charts and the recent
   runs table.
   ============================================================================= */

import type { Metadata } from "next";

import { AnalyticsClient } from "@/components/analytics/AnalyticsClient";
import { PageHeader } from "@/components/layout/PageHeader";

export const metadata: Metadata = {
  title: "Analytics",
  description: "Task volume, outcomes and duration trends across recorded agent runs.",
};

export default function AnalyticsPage(): React.JSX.Element {
  return (
    <div className="bw-shell">
      <PageHeader
        eyebrow="Analytics"
        title="Performance"
        lede="How the agent has been behaving over time: how much work it took on, how much of it succeeded, and how long runs take."
      />
      <AnalyticsClient />
    </div>
  );
}