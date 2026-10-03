/* =============================================================================
   Toast — transient confirmations (copied, cancelled, submitted)
   Renders in a fixed corner region with `role="status"`, auto-dismisses, and
   respects reduced motion.
   ============================================================================= */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AlertIcon, CheckIcon, InfoIcon } from "./icons";
import styles from "./Toast.module.css";

export type ToastTone = "success" | "info" | "error";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastValue {
  toast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

const ICONS: Record<ToastTone, ReactNode> = {
  success: <CheckIcon size={16} />,
  info: <InfoIcon size={16} />,
  error: <AlertIcon size={16} />,
};

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), 4_200);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {toasts.map((entry) => (
          <div key={entry.id} className={styles.toast} data-tone={entry.tone}>
            <span className={styles.icon} aria-hidden="true">
              {ICONS[entry.tone]}
            </span>
            <span className={styles.message}>{entry.message}</span>
            <button type="button" className={styles.close} onClick={() => dismiss(entry.id)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue["toast"] {
  const value = useContext(ToastContext);
  // A missing provider should never crash a page; degrade to a no-op.
  return value?.toast ?? (() => undefined);
}