/* =============================================================================
   Logo — inline wordmark
   Drawn rather than imported so the mark picks up the brand palette and scales
   cleanly at every size without a second network request.
   ============================================================================= */

import Link from "next/link";

import styles from "./Logo.module.css";

export interface LogoProps {
  href?: string;
  size?: "sm" | "md";
  /** Hides the wordmark, leaving the glyph — used in the collapsed mobile nav. */
  markOnly?: boolean;
}

export function Logo({ href = "/", size = "md", markOnly = false }: LogoProps): React.JSX.Element {
  return (
    <Link href={href} className={`${styles.root} ${styles[size]}`} aria-label="AgentWebEinh — go to dashboard">
      <span className={styles.glyph} aria-hidden="true">
        <svg viewBox="0 0 32 32" width="100%" height="100%" fill="none">
          <defs>
            <linearGradient id="awe-glyph" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--bw-gold)" />
              <stop offset="48%" stopColor="var(--bw-saffron)" />
              <stop offset="100%" stopColor="var(--bw-chocolate)" />
            </linearGradient>
          </defs>
          {/* Browser frame with an agent pulse in the viewport. */}
          <rect x="2.6" y="5.4" width="26.8" height="21.2" rx="5" stroke="url(#awe-glyph)" strokeWidth="2" />
          <path d="M2.6 11.6h26.8" stroke="url(#awe-glyph)" strokeWidth="2" />
          <circle cx="7.2" cy="8.5" r="1.15" fill="var(--bw-gold)" />
          <circle cx="11.4" cy="8.5" r="1.15" fill="var(--bw-saffron)" />
          <path
            d="M16 15.4l1.55 3.55 3.55 1.55-3.55 1.55L16 25.6l-1.55-3.55L10.9 20.5l3.55-1.55L16 15.4Z"
            fill="url(#awe-glyph)"
          />
        </svg>
      </span>
      {markOnly ? null : (
        <span className={styles.word}>
          Agent<span className={styles.accent}>Web</span>Einh
        </span>
      )}
    </Link>
  );
}