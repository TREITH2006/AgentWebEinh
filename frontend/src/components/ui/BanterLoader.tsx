/* =============================================================================
   BanterLoader
   -----------------------------------------------------------------------------
   Adapted from Uiverse.io "Banter Loader" by Nawsome: a nine-box grid that
   pulses in a sequenced wave. Colours are remapped from the original blue onto
   the approved brand ramp.

   Used for: task startup, loading a report, loading task detail.
   Deliberately never used as a full-page blocker — it lives inside the panel
   that is loading.
   ============================================================================= */

import styles from "./BanterLoader.module.css";

export interface BanterLoaderProps {
  /** Announced to screen readers and shown as a caption under the boxes. */
  label?: string;
  size?: "sm" | "md" | "lg";
}

const BOXES = 9;

export function BanterLoader({ label = "Working", size = "md" }: BanterLoaderProps): React.JSX.Element {
  return (
    <div className={`${styles.wrapper} ${styles[size]}`} role="status" aria-live="polite">
      <span className={styles.grid} aria-hidden="true">
        {Array.from({ length: BOXES }, (_, index) => (
          <span
            key={index}
            className={styles.box}
            style={{ animationDelay: `${(index % 3) * 90 + Math.floor(index / 3) * 60}ms` }}
          />
        ))}
      </span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}