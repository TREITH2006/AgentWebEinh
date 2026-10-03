/* =============================================================================
   Small shared hooks
   ============================================================================= */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Tracks the user's reduced-motion preference and reacts to changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * One-shot "has entered the viewport" flag used to drive reveals and chart
 * animations. `once` keeps charts from re-animating on every scroll pass.
 */
export function useInView<T extends Element>(options?: { once?: boolean; threshold?: number; rootMargin?: string }): {
  ref: React.RefObject<T | null>;
  inView: boolean;
} {
  const { once = true, threshold = 0.2, rootMargin = "0px 0px -12% 0px" } = options ?? {};
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (once) observer.unobserve(entry.target);
          } else if (!once) {
            setInView(false);
          }
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [once, threshold, rootMargin]);

  return { ref, inView };
}

/**
 * Counts from 0 to `value` once the element is visible.
 * Snapshots to the final value immediately under reduced motion.
 */
export function useCountUp(value: number, active: boolean, durationMs = 1_100): number {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);

    if (!active || reduced || durationMs <= 0) {
      setDisplay(value);
      return;
    }

    const from = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      // easeOutExpo — fast start, gentle settle.
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplay(from + (value - from) * eased);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
      else frame.current = null;
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [value, active, reduced, durationMs]);

  return display;
}

/** Ticking elapsed-milliseconds clock that pauses on demand. */
export function useElapsed(startedAt: number | null, running: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }
    if (!running) {
      setElapsed(Date.now() - startedAt);
      return;
    }
    setElapsed(Date.now() - startedAt);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, [startedAt, running]);

  return elapsed;
}

/** Debounced mirror of a rapidly changing value (used by the search field). */
export function useDebounced<T>(value: T, delayMs = 260): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/** Locks body scroll while a modal or drawer is open. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

/** Latest-value ref, for use inside long-lived callbacks like timers. */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Stable callback identity that always sees the latest closure. */
export function useEvent<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const ref = useLatest(handler);
  return useCallback((...args: Args) => ref.current(...args), [ref]);
}

/**
 * Measured content-box size of an element.
 * Charts render at real pixel dimensions rather than scaling a fixed viewBox, so
 * stroke weights and label sizes stay crisp at any width.
 */
export function useElementSize<T extends Element>(): {
  ref: React.RefObject<T | null>;
  width: number;
  height: number;
} {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize((current) =>
        Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height },
      );
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, width: size.width, height: size.height };
}