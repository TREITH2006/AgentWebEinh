/* =============================================================================
   WaveLoader
   -----------------------------------------------------------------------------
   Adapted from Uiverse.io "Wave" by mrpumps31232: four bars bouncing on a
   stagger. The original blue is replaced with the saffron -> gold ramp so the
   loading states stay inside the product's colour identity.

   Used for: compact waits — waiting for the first task event, refreshing a
   dashboard panel, any operation under roughly two seconds.
   ============================================================================= */

import styles from "./WaveLoader.module.css";

export interface WaveLoaderProps {
  label?: string;
  size?: "sm" | "md";
  /** Renders only the bars when false, for inline use beside text. */
  showLabel?: boolean;
}

export function WaveLoader({ label = "Loading", size = "sm", showLabel = true }: WaveLoaderProps): React.JSX.Element {
  return (
    <span className={`${styles.wrapper} ${styles[size]}`} role="status" aria-live="polite">
      <span className={styles.bars} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} className={styles.bar} style={{ animationDelay: `${index * 110}ms` }} />
        ))}
      </span>
      {showLabel ? <span className={styles.label}>{label}</span> : <span className="bw-sr-only">{label}</span>}
    </span>
  );
}