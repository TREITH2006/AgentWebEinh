/* =============================================================================
   Loading / empty / error states
   One set of primitives so every list, panel and page in the product handles
   these three cases the same way.
   ============================================================================= */

import type { ReactNode } from "react";

import { BanterLoader } from "./BanterLoader";
import { WaveLoader } from "./WaveLoader";
import { ArrowRightIcon } from "./icons";
import styles from "./States.module.css";

/* -------------------------------------------------------------- skeleton -- */

export interface SkeletonProps {
  width?: string;
  height?: string;
  radius?: string;
  className?: string;
}

export function Skeleton({ width = "100%", height = "14px", radius = "6px", className }: SkeletonProps): React.JSX.Element {
  return <span className={[styles.skeleton, className ?? ""].filter(Boolean).join(" ")} style={{ width, height, borderRadius: radius }} />;
}

/** Text-block placeholder used while a list loads. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }): React.JSX.Element {
  return (
    <div className={[styles.skeletonGroup, className ?? ""].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <Skeleton width="34px" height="34px" radius="50%" />
          <div className={styles.skeletonText}>
            <Skeleton width={`${58 + ((index * 13) % 34)}%`} height="13px" />
            <Skeleton width={`${34 + ((index * 7) % 22)}%`} height="11px" />
          </div>
          <Skeleton width="72px" height="20px" radius="999px" />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- empty -- */

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "warning";
}

export function EmptyState({ title, description, icon, action, tone = "neutral" }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={styles.empty} data-tone={tone}>
      {icon ? <div className={styles.emptyIcon}>{icon}</div> : null}
      <h3 className={styles.emptyTitle}>{title}</h3>
      {description ? <p className={styles.emptyBody}>{description}</p> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- error -- */

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  compact = false,
}: ErrorStateProps): React.JSX.Element {
  return (
    <div className={styles.error} data-compact={compact || undefined} role="alert">
      <div className={styles.errorHead}>
        <span className={styles.errorIcon} aria-hidden="true">
          !
        </span>
        <h3 className={styles.errorTitle}>{title}</h3>
      </div>
      <p className={styles.errorBody}>{message}</p>
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          {retryLabel}
          <ArrowRightIcon size={15} />
        </button>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- loaders -- */

export interface PanelLoaderProps {
  label: string;
  /** `panel` is the default and stays inside its container. */
  variant?: "panel" | "inline";
}

export function PanelLoader({ label, variant = "panel" }: PanelLoaderProps): React.JSX.Element {
  if (variant === "inline") return <WaveLoader label={label} />;
  return (
    <div className={styles.loader}>
      <BanterLoader label={label} size="md" />
    </div>
  );
}

/** Full-height loader for a route that has nothing else to render yet. */
export function RouteLoader({ label = "Loading" }: { label?: string }): React.JSX.Element {
  return (
    <div className={styles.routeLoader}>
      <BanterLoader label={label} size="lg" />
    </div>
  );
}