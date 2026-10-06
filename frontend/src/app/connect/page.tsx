/* =============================================================================
   Connect a browser route
   -----------------------------------------------------------------------------
   Server shell. ConnectClient owns pairing-code minting and the live list of
   paired browser extensions.
   ============================================================================= */

import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";
import { ConnectClient } from "@/components/connect/ConnectClient";

export const metadata: Metadata = {
  title: "Connect a browser",
  description: "Pair your real Chrome with AgentWebEinh to run tasks in your own browser.",
};

export default function ConnectPage(): React.JSX.Element {
  return (
    <div className="bw-shell">
      <PageHeader
        eyebrow="Pairing"
        title="Connect a browser"
        lede="Mint a one-time code, type it into the AgentWebEinh extension popup, and your real Chrome becomes the engine for upcoming tasks."
      />
      <ConnectClient />
    </div>
  );
}