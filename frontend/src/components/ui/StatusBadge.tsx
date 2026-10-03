/* =============================================================================
   StatusBadge + Badge
   ============================================================================= */

import type { ReactNode } from "react";

import { statusMeta, type StatusTone } from "@/lib/status";
import type { TaskStatus } from "@/types/domain";
import styles from "./StatusBadge.module.css";

export interface StatusBadgeProps {
  status: TaskStatus;
  size?: "sm" | "md";
  /** Adds a pulsing dot for live states. */
  pulse?: boolean;
  className?: string;
}

export function StatusBadge({ status, size = "md", pulse = true, className }: StatusBadgeProps): React.JSX.Element {
  const meta = statusMeta(status);
  const showPulse = pulse && meta.live;

  return (
    <span
      className={[styles.badge, styles[meta.tone], styles[size], className ?? ""].filter(Boolean).join(" ")}
      title={meta.description}
    >
      <span className={styles.dotWrap} aria-hidden="true">
        <span className={styles.dot} data-pulse={showPulse || undefined} />
        {showPulse ? <span className={styles.ring} /> : null}
      </span>
      {meta.label}
    </span>
  );
}

export interface BadgeProps {
  tone?: StatusTone | "neutral";
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
  className?: string;
}

/** Small inline label used for origins, counts and hints. */
export function Badge({ tone = "neutral", children, icon, title, className }: BadgeProps): React.JSX.Element {
  return (
    <span
      className={[styles.pill, styles[`pill-${tone}`], className ?? ""].filter(Boolean).join(" ")}
      title={title}
    >
      {icon ? <span className={styles.pillIcon}>{icon}</span> : null}
      {children}
    </span>
  );
}