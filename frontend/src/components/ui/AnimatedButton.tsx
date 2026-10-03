"use client";

/* =============================================================================
   AnimatedButton / AnimatedLink
   -----------------------------------------------------------------------------
   Adapted from the Uiverse.io "animated text button" design by KINGFRESS: two
   stacked text layers, the upper one leaving upwards while the lower one rises
   into view, with a per-character stagger.

   Adaptation notes:
     * CSS is scoped through a CSS Module — no global element or class selectors,
       so nothing here can leak onto other buttons in the app.
     * The colour cycle uses the five approved brand colours.
     * Both visual layers are aria-hidden and the accessible name comes from
       `label`, so screen readers announce the label once rather than twice.
     * Fixed dimensions were replaced with padding + intrinsic sizing so the
       control stays responsive; the label wraps if the text is long.
     * Loading and disabled states keep the same footprint to avoid layout shift.
     * `AnimatedLink` renders a real Next.js <Link> so navigation stays
       client-side while keeping the identical motion.
   ============================================================================= */

import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./AnimatedButton.module.css";

export type AnimatedButtonVariant = "primary" | "secondary" | "danger" | "quiet";
export type AnimatedButtonSize = "sm" | "md" | "lg";

interface AnimatedBaseProps {
  label: string;
  variant?: AnimatedButtonVariant;
  size?: AnimatedButtonSize;
  icon?: ReactNode;
  fullWidth?: boolean;
  className?: string;
}

function classNames(variant: AnimatedButtonVariant, size: AnimatedButtonSize, fullWidth: boolean, className?: string): string {
  return [styles.button, styles[variant], styles[size], fullWidth ? styles.fullWidth : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
}

/** Renders the staggered character grid twice, once per layer. */
function LayerStack({ label, icon, lower }: { label: string; icon?: ReactNode; lower: boolean }): React.JSX.Element {
  return (
    <span className={`${styles.layer} ${lower ? styles.layerLower : ""}`} aria-hidden="true">
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.text}>
        {[...label].map((character, index) => (
          <span key={`${character}-${index}`} className={styles.char} style={{ "--i": index } as React.CSSProperties}>
            {character === " " ? " " : character}
          </span>
        ))}
      </span>
    </span>
  );
}

export interface AnimatedButtonProps
  extends AnimatedBaseProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> {
  loading?: boolean;
  loadingText?: string;
}

export function AnimatedButton({
  label,
  variant = "primary",
  size = "md",
  icon,
  fullWidth = false,
  className,
  loading = false,
  loadingText,
  disabled,
  type = "button",
  ...rest
}: AnimatedButtonProps): React.JSX.Element {
  const isDisabled = disabled === true || loading;

  return (
    <button
      {...rest}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      aria-label={rest["aria-label"] ?? label}
      className={classNames(variant, size, fullWidth, className)}
    >
      <span className={styles.backdrop} aria-hidden="true" />
      {loading ? (
        <span className={styles.loadingRow}>
          <span className={styles.spinner} aria-hidden="true" />
          <span>{loadingText ?? label}</span>
        </span>
      ) : (
        <>
          <LayerStack label={label} icon={icon} lower={false} />
          <LayerStack label={label} icon={icon} lower />
        </>
      )}
    </button>
  );
}

export interface AnimatedLinkProps extends AnimatedBaseProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "className"> {
  href: string;
}

export function AnimatedLink({
  label,
  href,
  variant = "primary",
  size = "md",
  icon,
  fullWidth = false,
  className,
  ...rest
}: AnimatedLinkProps): React.JSX.Element {
  return (
    <Link href={href} aria-label={rest["aria-label"] ?? label} className={classNames(variant, size, fullWidth, className)} {...rest}>
      <span className={styles.backdrop} aria-hidden="true" />
      <LayerStack label={label} icon={icon} lower={false} />
      <LayerStack label={label} icon={icon} lower />
    </Link>
  );
}