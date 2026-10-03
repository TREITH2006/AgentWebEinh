/* =============================================================================
   Reveal — scroll-triggered entrance wrapper
   Uses the global `.bw-reveal` class so a single reduced-motion rule covers every
   reveal in the product.
   ============================================================================= */

"use client";

import type { ElementType, ReactNode } from "react";

import { useInView } from "@/lib/hooks/useUtilities";

export interface RevealProps {
  children: ReactNode;
  /** Stagger offset in milliseconds. */
  delay?: number;
  variant?: "up" | "scale";
  as?: ElementType;
  className?: string;
  id?: string;
}

export function Reveal({ children, delay = 0, variant = "up", as, className, id }: RevealProps): React.JSX.Element {
  const Tag = (as ?? "div") as ElementType;
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.12 });

  return (
    <Tag
      ref={ref}
      id={id}
      data-visible={inView}
      className={[variant === "scale" ? "bw-reveal-scale" : "bw-reveal", className ?? ""].filter(Boolean).join(" ")}
      style={{ "--bw-reveal-delay": `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </Tag>
  );
}