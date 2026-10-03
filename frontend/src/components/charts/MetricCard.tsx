/* =============================================================================
   MetricCard + CountUp
   -----------------------------------------------------------------------------
   A metric card counts up once when it scrolls into view, then stays put. It
   never re-animates on a timer and never shows a number the backend did not
   supply — unavailable values render as an em dash with an explanation.
   ============================================================================= */

import type { ReactNode } from "react";

import { useCountUp, useInView } from "@/lib/hooks/useUtilities";
import { Badge } from "@/components/ui/StatusBadge";
import styles from "./Charts.module.css";

export interface CountUpProps {
  value: number | null;
  /** Rendered for each animated unit. Defaults to a rounded integer. */
  format?: (value: number) => string;
  active?: boolean;
  durationMs?: number;
  className?: string;
}

export function CountUp({ value, format, active = true, durationMs = 1_100, className }: CountUpProps): React.JSX.Element {
  const render = format ?? ((input: number) => new Intl.NumberFormat("en").format(Math.round(input)));
  // useCountUp must run unconditionally, so an absent value is fed as 0 and
  // handled in the render branch below.
  const animated = useCountUp(typeof value === "number" && Number.isFinite(value) ? value : 0, active, durationMs);
  if (typeof value !== "number" || !Number.isFinite(value)) return <span className={className}>—</span>;
  return <span className={className}>{render(animated)}</span>;
}

export interface MetricCardProps {
  label: string;
  value: number | null;
  format?: (value: number) => string;
  hint?: string;
  icon?: ReactNode;
  tone?: "default" | "success" | "danger" | "accent";
  /** Rendered under the value, e.g. a mini bar. */
  footer?: ReactNode;
  /** Marks the value as sample data. */
  isDemo?: boolean;
  delay?: number;
}

export function MetricCard({
  label,
  value,
  format,
  hint,
  icon,
  tone = "default",
  footer,
  isDemo,
  delay = 0,
}: MetricCardProps): React.JSX.Element {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.35 });

  return (
    <div
      ref={ref}
      data-visible={inView}
      className={`${styles.metric} bw-reveal-scale`}
      style={{ "--bw-reveal-delay": `${delay}ms` } as React.CSSProperties}
      data-tone={tone}
    >
      <div className={styles.metricTop}>
        <span className={styles.metricLabel}>{label}</span>
        {isDemo ? <Badge tone="warning">Sample</Badge> : icon ? <span className={styles.metricIcon}>{icon}</span> : null}
      </div>
      <div className={styles.metricValue}>
        <CountUp value={value} format={format} active={inView} />
      </div>
      {hint ? <p className={styles.metricHint}>{hint}</p> : null}
      {footer ? <div className={styles.metricFooter}>{footer}</div> : null}
    </div>
  );
}