/* =============================================================================
   DataSourceMenu
   -----------------------------------------------------------------------------
   Shows exactly where the app is getting its data and lets a reviewer switch
   between the live backend and the isolated demo dataset without restarting the
   dev server. It is deliberately visible rather than hidden in a settings page:
   the separation between real and sample data is a product requirement.
   ============================================================================= */

"use client";

import { useEffect, useRef, useState } from "react";

import { useDataSource } from "@/lib/data-source";
import type { ApiMode } from "@/lib/config";
import type { SourceStatus } from "@/lib/data-source";
import { Badge } from "@/components/ui/StatusBadge";
import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";
import styles from "./DataSourceMenu.module.css";

const OPTIONS: readonly { value: ApiMode; label: string; detail: string }[] = [
  { value: "auto", label: "Auto", detail: "Use the backend when it is reachable" },
  { value: "live", label: "Live backend", detail: "Always call the AgentWebEinh API" },
  { value: "demo", label: "Demo data", detail: "Sample tasks and simulated runs" },
];

/** Never say "Demo" for a state that is not demo data. */
function statusLabel(status: SourceStatus): string {
  switch (status) {
    case "checking":
      return "Checking…";
    case "live":
      return "Live";
    case "demo":
      return "Demo";
    case "error":
      return "Error";
  }
}

export function DataSourceMenu(): React.JSX.Element {
  const { status, override, setOverride, reason } = useDataSource();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = statusLabel(status);

  return (
    <div className={styles.root} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={reason ?? `Data source: ${label}`}
      >
        <span className={styles.dot} data-status={status} aria-hidden="true" />
        <span className={styles.triggerLabel}>{label}</span>
        <ChevronDownIcon size={13} />
      </button>

      {open ? (
        <div className={styles.menu} role="menu" aria-label="Data source">
          <p className={styles.menuHead}>
            Data source
            <span className={styles.menuSub}>Controls whether the app calls the backend.</span>
          </p>
          <ul className={styles.options}>
            {OPTIONS.map((option) => {
              const selected = (override ?? "auto") === option.value;
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={styles.option}
                    data-selected={selected || undefined}
                    onClick={() => {
                      setOverride(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.optionMain}>
                      <span className={styles.optionLabel}>{option.label}</span>
                      <span className={styles.optionDetail}>{option.detail}</span>
                    </span>
                    {selected ? <CheckIcon size={15} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className={styles.menuFoot}>
            {status === "live" ? (
              <Badge tone="success">Connected to backend</Badge>
            ) : status === "error" ? (
              <Badge tone="danger">Backend not in use</Badge>
            ) : status === "checking" ? (
              <Badge tone="neutral">Checking backend…</Badge>
            ) : (
              <Badge tone="warning">Showing sample data</Badge>
            )}
          </div>
          {reason ? <p className={styles.reason}>{reason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}