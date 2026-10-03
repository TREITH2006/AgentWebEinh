/* =============================================================================
   DemoModeBanner
   -----------------------------------------------------------------------------
   A persistent, dismissible-per-session strip shown whenever the app is serving
   sample data or a simulated run. Its job is to make it impossible to mistake
   demo content for real agent activity.
   ============================================================================= */

"use client";

import { useEffect, useState } from "react";

import { useDataSource } from "@/lib/data-source";
import styles from "./DemoModeBanner.module.css";

const DISMISS_KEY = "agentwebeinh:demo-banner-dismissed";

export function DemoModeBanner(): React.JSX.Element | null {
  const { isDemo, reason, status } = useDataSource();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!isDemo || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* session storage unavailable — banner returns next load */
    }
  };

  return (
    <div className={styles.banner} role="status">
      <div className={`bw-shell-wide ${styles.inner}`}>
        <span className={styles.tag} data-checking={status === "checking" || undefined}>
          {status === "checking" ? "Checking" : "Demo mode"}
        </span>
        <p className={styles.text}>
          {status === "checking"
            ? "Looking for the AgentWebEinh backend…"
            : "Showing sample tasks and a simulated run. No real browser session is active."}
          {reason ? <span className={styles.reason}> {reason}</span> : null}
        </p>
        <button type="button" className={styles.dismiss} onClick={dismiss} aria-label="Dismiss demo notice for this session">
          ×
        </button>
      </div>
    </div>
  );
}