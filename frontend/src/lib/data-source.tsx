/* =============================================================================
   Data source resolution
   -----------------------------------------------------------------------------
   The single switch that decides whether the app talks to the backend or falls
   back to synthetic demo content, plus the service instance every hook consumes.

   Resolution order:
     1. `NEXT_PUBLIC_API_MODE=live`  -> always live.
     2. `NEXT_PUBLIC_API_MODE=demo`  -> always demo.
     3. `auto`                       -> probe the backend once; demo if unreachable.
     4. A user override stored in localStorage always wins, so the live and demo
        experiences can be reviewed without restarting the dev server.
   ============================================================================= */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { API_CONFIG, type ApiMode } from "./config";
import { API_ENDPOINTS } from "./api/endpoints";
import { probeHealth } from "./api/client";
import { TaskEventStream, type StreamUpdate } from "./api/events";
import {
  createDemoService,
  createLiveService,
  createLiveTask,
  type AgentService,
  type CreateTaskFn,
} from "./api/service";
import { DemoRunSession, buildDemoScript } from "./demo/simulator";

const OVERRIDE_KEY = "agentwebeinh:datasource";

export type ResolvedMode = "live" | "demo";
export type SourceStatus = "checking" | "live" | "demo";

export interface DataSourceValue {
  mode: ResolvedMode;
  isDemo: boolean;
  status: SourceStatus;
  /** Why demo mode is active. Shown in the data-source menu. */
  reason: string | null;
  /** The user's explicit choice, if any. */
  override: ApiMode | null;
  setOverride: (value: ApiMode) => void;
  /** Service bound to the active mode. */
  service: AgentService;
  /** Submit a task. In demo mode this returns a demo run id. */
  submitTask: CreateTaskFn;
  /** Open a live (or simulated) update stream for a task. */
  openStream: (taskId: string, prompt: string, onUpdate: (update: StreamUpdate) => void) => TaskEventStream | DemoRunSession;
}

const DataSourceContext = createContext<DataSourceValue | null>(null);

function readStoredOverride(): ApiMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return raw === "live" || raw === "demo" || raw === "auto" ? raw : null;
  } catch {
    return null;
  }
}

export function DataSourceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [override, setOverrideState] = useState<ApiMode | null>(null);
  const [status, setStatus] = useState<SourceStatus>(
    API_CONFIG.mode === "demo" ? "demo" : "checking",
  );
  const [reason, setReason] = useState<string | null>(
    API_CONFIG.mode === "demo" ? "Demo mode forced by NEXT_PUBLIC_API_MODE." : null,
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const stored = readStoredOverride();
    if (stored) setOverrideState(stored);
    return () => {
      mounted.current = false;
    };
  }, []);

  const effective: ApiMode = override ?? API_CONFIG.mode;

  useEffect(() => {
    if (effective === "demo") {
      setStatus("demo");
      setReason(override === "demo" ? "Demo mode selected in the data-source menu." : "Demo mode forced by NEXT_PUBLIC_API_MODE.");
      return;
    }

    if (effective === "live") {
      // Trust the operator: do not silently swap to demo if the probe is slow.
      setStatus("live");
      setReason(null);
      return;
    }

    let cancelled = false;
    setStatus("checking");
    setReason(null);

    void probeHealth(API_ENDPOINTS.health, API_CONFIG.probeTimeoutMs).then((result) => {
      if (cancelled || !mounted.current) return;
      if (result.ok) {
        setStatus("live");
        setReason(null);
      } else {
        setStatus("demo");
        setReason(`No backend detected (${result.reason}). Showing sample data so the interface stays usable.`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [effective, override]);

  const setOverride = useCallback((value: ApiMode) => {
    setOverrideState(value);
    try {
      if (value === API_CONFIG.mode) window.localStorage.removeItem(OVERRIDE_KEY);
      else window.localStorage.setItem(OVERRIDE_KEY, value);
    } catch {
      /* storage unavailable — in-memory override still applies */
    }
  }, []);

  const service = useMemo(() => (status === "live" ? createLiveService() : createDemoService()), [status]);

  const submitTask = useCallback<CreateTaskFn>(
    async (prompt, signal) => {
      if (status === "live") return createLiveTask(prompt, signal);
      const { taskId, outcome } = buildDemoScript(prompt);
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return { taskId, status: outcome === "failed" ? "queued" : "queued", eventsUrl: null };
    },
    [status],
  );

  const openStream = useCallback<DataSourceValue["openStream"]>(
    (taskId, prompt, onUpdate) =>
      status === "live"
        ? new TaskEventStream({ taskId, origin: "api", onUpdate })
        : new DemoRunSession(prompt, onUpdate),
    [status],
  );

  const value = useMemo<DataSourceValue>(
    () => ({
      mode: status === "live" ? "live" : "demo",
      isDemo: status !== "live",
      status,
      reason,
      override,
      setOverride,
      service,
      submitTask,
      openStream,
    }),
    [status, reason, override, setOverride, service, submitTask, openStream],
  );

  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSourceValue {
  const value = useContext(DataSourceContext);
  if (!value) throw new Error("useDataSource must be used inside <DataSourceProvider>.");
  return value;
}