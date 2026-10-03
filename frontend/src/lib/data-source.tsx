/* =============================================================================
   Data source resolution
   -----------------------------------------------------------------------------
   The single switch that decides whether the app talks to the backend or falls
   back to synthetic demo content, plus the service instance every hook consumes.

   Resolution order:
     1. A user override stored in localStorage always wins, so the live and demo
        experiences can be reviewed without restarting the dev server.
     2. `NEXT_PUBLIC_API_MODE=live`  -> live, always.
     3. `NEXT_PUBLIC_API_MODE=demo`  -> demo, always.
     4. `auto`                       -> probe, then decide (below).

   The probe is an identity check against `GET /api/status`, not a liveness ping:
   a bare 200 is satisfied by unrelated services, and treating one of those as the
   live backend is how a working-looking UI ended up talking to an API that 404s
   every real endpoint. See `api/status.ts`.

   Outcome matrix, and the reasoning behind it:

     effective = live                probe ok       -> live
                                    probe failed   -> ERROR, service stays live
                                                      so every panel reports the
                                                      real failure. Demo is never
                                                      substituted: the operator
                                                      asked for live, and silently
                                                      serving sample data under a
                                                      "Live backend" label would
                                                      misrepresent the system.

     effective = auto                probe ok       -> live
                                    unreachable    -> demo (documented fallback;
                                                      the banner states plainly
                                                      that the data is sample)
                                    wrong identity -> ERROR, not demo. The service
                                                      is reachable but unusable,
                                                      which is a misconfiguration to
                                                      fix, not a reason to hide it
                                                      behind sample data.

   Demo data is only ever created when `status === "demo"`; every other state
   binds the live service, so no code path can quietly emit demo content.
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
import { probeBackend, type BackendFailure, type FetchLike } from "./api/status";
import { decideSource, type SourceStatus } from "./api/source-policy";
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
export type { SourceStatus };

export interface DataSourceValue {
  mode: ResolvedMode;
  isDemo: boolean;
  status: SourceStatus;
  /** Why demo or error state is active. Shown in the banner and data-source menu. */
  reason: string | null;
  /** The probe failure behind `status === "error"`, if any. */
  connectionError: BackendFailure | null;
  /** The user's explicit choice, if any. */
  override: ApiMode | null;
  setOverride: (value: ApiMode) => void;
  /** Re-run the identity probe. Enabled when a failure is worth retrying. */
  recheck: () => void;
  /** Service bound to the active mode. */
  service: AgentService;
  /** Submit a task. In demo mode this returns a demo run id. */
  submitTask: CreateTaskFn;
  /** Open a live (or simulated) update stream for a task. */
  openStream: (taskId: string, prompt: string, onUpdate: (update: StreamUpdate) => void) => TaskEventStream | DemoRunSession;
}

const DataSourceContext = createContext<DataSourceValue | null>(null);

/** Indirection so the probe can be stubbed and the module stays testable. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

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
  const [connectionError, setConnectionError] = useState<BackendFailure | null>(null);
  const [probeNonce, setProbeNonce] = useState(0);
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

  const recheck = useCallback(() => setProbeNonce((value) => value + 1), []);

  useEffect(() => {
    if (effective === "demo") {
      setStatus("demo");
      setConnectionError(null);
      setReason(
        override === "demo"
          ? "Demo mode selected in the data-source menu."
          : "Demo mode forced by NEXT_PUBLIC_API_MODE.",
      );
      return;
    }

    // Both live and auto verify identity. Live used to skip this entirely and
    // assume success, which reported "connected" while every call 404'd.
    let cancelled = false;
    setStatus("checking");
    setConnectionError(null);
    setReason(null);

    void probeBackend(defaultFetch, API_CONFIG.probeTimeoutMs).then((result) => {
      if (cancelled || !mounted.current) return;

      const decision = decideSource(effective, result);

      setStatus(decision.status);
      setConnectionError(result.ok ? null : result);
      setReason(decision.reason);
    });

    return () => {
      cancelled = true;
    };
  }, [effective, override, probeNonce]);

  const setOverride = useCallback((value: ApiMode) => {
    setOverrideState(value);
    try {
      if (value === API_CONFIG.mode) window.localStorage.removeItem(OVERRIDE_KEY);
      else window.localStorage.setItem(OVERRIDE_KEY, value);
    } catch {
      /* storage unavailable — in-memory override still applies */
    }
  }, []);

  // `decideSource().useDemo` is the only thing that unlocks the demo service, so
  // an unresolved or failing connection can never yield samples.
  const service = useMemo(
    () => (status === "demo" ? createDemoService() : createLiveService()),
    [status],
  );

  const submitTask = useCallback<CreateTaskFn>(
    async (prompt, signal) => {
      if (status !== "demo") return createLiveTask(prompt, signal);
      const { taskId, outcome } = buildDemoScript(prompt);
      await new Promise((resolve) => setTimeout(resolve, 420));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return { taskId, status: outcome === "failed" ? "queued" : "queued", eventsUrl: null };
    },
    [status],
  );

  const openStream = useCallback<DataSourceValue["openStream"]>(
    (taskId, prompt, onUpdate) =>
      status === "demo"
        ? new DemoRunSession(prompt, onUpdate)
        : new TaskEventStream({ taskId, origin: "api", onUpdate }),
    [status],
  );

  const value = useMemo<DataSourceValue>(
    () => ({
      mode: status === "demo" ? "demo" : "live",
      isDemo: status === "demo",
      status,
      reason,
      connectionError,
      override,
      setOverride,
      recheck,
      service,
      submitTask,
      openStream,
    }),
    [status, reason, connectionError, override, setOverride, recheck, service, submitTask, openStream],
  );

  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSourceValue {
  const value = useContext(DataSourceContext);
  if (!value) throw new Error("useDataSource must be used inside <DataSourceProvider>.");
  return value;
}