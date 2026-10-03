/* =============================================================================
   PageHeader
   -----------------------------------------------------------------------------
   The consistent opening block for every route: eyebrow, title, lede and an
   optional action slot. Centralising it keeps the vertical rhythm identical
   across dashboard, history, analytics, task detail and about.
   ============================================================================= */

import type { ReactNode } from "react";

import { Reveal } from "@/components/ui/Reveal";
import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
  eyebrow: string;
  title: string;
  lede?: string;
  /** Buttons or links rendered opposite the title on wide screens. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function PageHeader({ eyebrow, title, lede, actions, children }: PageHeaderProps): React.JSX.Element {
  return (
    <header className={styles.root}>
      <Reveal className={styles.copy}>
        <p className={`bw-eyebrow ${styles.eyebrow}`}>{eyebrow}</p>
        <h1 className={styles.title}>{title}</h1>
        {lede ? <p className={styles.lede}>{lede}</p> : null}
        {children}
      </Reveal>
      {actions ? <Reveal delay={80} className={styles.actions}>{actions}</Reveal> : null}
    </header>
  );
}