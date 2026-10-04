/* =============================================================================
   DemoModeBanner
   -----------------------------------------------------------------------------
   Sits above the shell and states, in the app's own chrome, whether the app is
   serving sample data or a simulated run. Its job is to make it impossible to
   mistake demo content for real agent activity.

   Three states:
     - demo     : sample data is on screen. Dismissible for the session, because
                  the operator has been told and the data stays labelled.
     - checking : the identity probe is in flight, so nothing is claimed yet.
     - error    : the live backend was requested but could not be verified.
                  Deliberately NOT dismissible and NOT replaced with demo data —
                  a broken connection that can be swiped away is how it goes
                  unnoticed.
   ============================================================================= */

"use client";

import { useEffect, useState } from "react";

import { useDataSource } from "@/lib/data-source";
import { AlertIcon } from "@/components/ui/icons";
import styles from "./DemoModeBanner.module.css";

const DISMISS_KEY = "agentwebeinh:demo-banner-dismissed";

/**
 * Headline per failure kind.
 *
 * "Live backend unavailable" was shown for every failure, which made a slow
 * backend look dead and a gateway fault look like a backend fault. Each cause has
 * a different fix -- wait, check the backend, or check the proxy -- so each gets
 * its own headline.
 */
const ERROR_HEADLINES: Record<string, string> = {
  "frontend-unavailable": "Frontend server unavailable",
  timeout: "Backend request timed out",
  "proxy-error": "Proxy error",
  "backend-unavailable": "Backend unavailable",
  "wrong-backend": "Wrong service on this address",
  "endpoint-error": "Backend returned an error",
};

export function DemoModeBanner(): React.JSX.Element | null {
  const { isDemo, reason, status, connectionError, recheck } = useDataSource();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const isError = status === "error";

  // An error is always shown; only the demo notice can be waved away.
  if (isError) {
    const headline = connectionError
      ? (ERROR_HEADLINES[connectionError.kind] ?? "Live backend unavailable")
      : "Live backend unavailable";
    return (
      <div className={styles.banner} data-status="error" data-error-kind={connectionError?.kind} role="alert">
        <div className={`bw-shell-wide ${styles.inner}`}>
          <span className={styles.tag} data-error="true">
            <AlertIcon size={11} />
            {headline}
          </span>
          <p className={styles.text}>
            {reason ?? "The AgentWebEinh API could not be verified."}
            {connectionError ? (
              <span className={styles.reason}>
                {" "}
                Checked <code>{connectionError.url}</code>
                {connectionError.httpStatus > 0
                  ? ` — HTTP ${connectionError.httpStatus}`
                  : connectionError.kind === "timeout"
                    ? " — no answer before the deadline"
                    : " — no response"}
                . No sample data is being substituted for live results.
              </span>
            ) : null}
          </p>
          <button type="button" className={styles.retry} onClick={recheck}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!isDemo || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* session storage unavailable - banner returns next load */
    }
  };

  return (
    <div className={styles.banner} data-status="demo" role="status">
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
        <button
          type="button"
          className={styles.dismiss}
          onClick={dismiss}
          aria-label="Dismiss demo notice for this session"
        >
          x
        </button>
      </div>
    </div>
  );
}