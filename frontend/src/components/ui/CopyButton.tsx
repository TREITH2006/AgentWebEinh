/* =============================================================================
   CopyButton — clipboard action with inline confirmation
   Falls back to a hidden textarea + execCommand where the async clipboard API is
   unavailable (non-secure origins), so it never silently fails.
   ============================================================================= */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CheckIcon, CopyIcon } from "./icons";
import styles from "./CopyButton.module.css";

export interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  size?: "sm" | "md";
  variant?: "quiet" | "solid";
  icon?: React.ReactNode;
  className?: string;
}

async function writeToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  size = "md",
  variant = "quiet",
  icon,
  className,
}: CopyButtonProps): React.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    const ok = await writeToClipboard(value);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2_000);
  }, [value]);

  const text = state === "copied" ? copiedLabel : state === "failed" ? "Copy failed" : label;

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={[styles.button, styles[size], styles[variant], state === "copied" ? styles.copied : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      aria-live="polite"
    >
      <span className={styles.icon} aria-hidden="true">
        {icon ?? (state === "copied" ? <CheckIcon size={15} /> : <CopyIcon size={15} />)}
      </span>
      {text}
    </button>
  );
}