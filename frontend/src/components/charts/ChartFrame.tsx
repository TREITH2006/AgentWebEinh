/* =============================================================================
   Chart frame
   Shared chrome for every chart: title, optional legend, an empty state that
   refuses to render an empty axis, and an optional demo-data marker so sample
   numbers are never mistaken for measured ones.
   ============================================================================= */

"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/StatusBadge";
import styles from "./Charts.module.css";

export interface LegendItem {
  label: string;
  color: string;
  /** Renders a swatch; defaults to a line, use `swatch` for filled blocks. */
  variant?: "line" | "swatch";
}

export interface ChartFrameProps {
  title: string;
  description?: string;
  legend?: LegendItem[];
  isDemo?: boolean;
  /** Children receive nothing; the frame just provides the plot area. */
  children: ReactNode;
  empty?: boolean;
  emptyMessage?: string;
  footer?: ReactNode;
  className?: string;
  action?: ReactNode;
}

export function ChartFrame({
  title,
  description,
  legend,
  isDemo,
  children,
  empty,
  emptyMessage = "No data for this period yet.",
  footer,
  className,
  action,
}: ChartFrameProps): React.JSX.Element {
  return (
    <figure className={[styles.frame, className ?? ""].filter(Boolean).join(" ")}>
      <figcaption className={styles.frameHead}>
        <div className={styles.frameTitles}>
          <h3 className={styles.frameTitle}>{title}</h3>
          {description ? <p className={styles.frameDescription}>{description}</p> : null}
        </div>
        <div className={styles.frameMeta}>
          {isDemo ? <Badge tone="warning">Sample data</Badge> : null}
          {action}
        </div>
      </figcaption>

      {legend && legend.length > 0 ? (
        <ul className={styles.legend}>
          {legend.map((item) => (
            <li key={item.label} className={styles.legendItem}>
              <span
                className={item.variant === "swatch" ? styles.legendSwatch : styles.legendLine}
                style={{ background: item.color }}
                aria-hidden="true"
              />
              {item.label}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.plot}>{empty ? <p className={styles.empty}>{emptyMessage}</p> : children}</div>
      {footer ? <div className={styles.frameFooter}>{footer}</div> : null}
    </figure>
  );
}