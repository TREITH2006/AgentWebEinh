/* =============================================================================
   SectionHeading — the shared heading block used by every page section
   Keeps vertical rhythm and heading hierarchy consistent without repeating
   markup on each page.
   ============================================================================= */

import type { ReactNode } from "react";

import styles from "./SectionHeading.module.css";

export interface SectionHeadingProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  size?: "md" | "lg";
  actions?: ReactNode;
  id?: string;
  className?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  size = "md",
  actions,
  id,
  className,
}: SectionHeadingProps): React.JSX.Element {
  return (
    <div className={[styles.root, styles[align], className ?? ""].filter(Boolean).join(" ")}>
      <div className={styles.head}>
        {eyebrow ? (
          <span className="bw-eyebrow">
            <span className={`${styles.rule} bw-cycle-bar`} aria-hidden="true" />
            {eyebrow}
          </span>
        ) : null}
        <h2 id={id} className={`${styles.title} ${styles[size]}`}>
          {title}
        </h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}