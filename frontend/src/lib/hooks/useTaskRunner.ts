/* =============================================================================
   useTaskRunner
   -----------------------------------------------------------------------------
   Owns the whole lifecycle of one task on the dashboard:

     submit -> stream (websocket, polling fallback) -> terminal state -> report

   It deliberately holds no knowledge of transports or mock data; it drives the
   stream handed to it by the data-source provider, so live and demo runs follow
   exactly the same code path.
   ============================================================================= */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useDataSource } from "@/lib/data-source";
import type { StreamTransport, StreamUpdate, TaskEventStream } from "@/lib/api/events";
import type { DemoRunSession } from "@/lib/demo/simulator";
import { composeDemoReport, registerDemoRun } from "@/lib/demo/repository";
import type { AgentEvent, TaskRecord, TaskStatus } from "@/types/domain";
import { isTerminalStatus } from "@/types/domain";

export type RunPhase = "idle" | "submitting" | "active" | "settled";
export type CancelState = "idle" | "cancelling" | "unsupported" | "stopped";

const MAX_EVENTS = 400;

export interface TaskRunnerValue {
  phase: RunPhase;
  task: TaskRecord | null;
  prompt: string;
  events: AgentEvent[];
  transport: StreamTransport;
  transportNote: string | null;
  error: string | null;
  cancelState: CancelState;
  /** Terminal status of the most recent run, once it has settled. */
  lastOutcome: TaskStatus | null;
  start: (prompt: string) => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  canCancel: boolean;
}

type RunnerSession = TaskEventStream | DemoRunSession;

export function useTaskRunner(): TaskRunnerValue {
  const { service, submitTask, openStream, isDemo, status } = useDataSource();

  const [phase, setPhase] = useState<RunPhase>("idle");
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [transport, setTransport] = useState<StreamTransport>("closed");
  const [transportNote, setTransportNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelState, setCancelState] = useState<CancelState>("idle");
  const [lastOutcome, setLastOutcome] = useState<TaskStatus | null>(null);

  const sessionRef = useRef<RunnerSession | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const settledRef = useRef(false);
  /** Latest values, readable from long-lived stream callbacks. */
  const latest = useRef({ isDemo, prompt, events, service, taskId: null as string | null });
  latest.current = { isDemo, prompt, events, service, taskId: taskIdRef.current };

  const teardown = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
  }, []);

  /* ------------------------------------------------------------ finalise -- */

  const finalize = useCallback(
    async (record: TaskRecord) => {
      teardown();

      let finalRecord = record;
      const context = latest.current;

      // Re-read once the backend has settled: reports normally arrive on the
      // terminal record rather than on the last stream frame.
      if (!context.isDemo && context.taskId) {
        try {
          finalRecord = await context.service.getTask(context.taskId);
          setTask(finalRecord);
        } catch {
          /* keep the streamed record */
        }
      }

      if (context.isDemo) {
        const report = composeDemoReport(context.prompt, finalRecord.status === "failed");
        registerDemoRun({
          taskId: finalRecord.id,
          prompt: context.prompt,
          status: finalRecord.status,
          createdAt: finalRecord.createdAt,
          report,
          events: context.events,
        });
        setTask({ ...finalRecord, report });
      }

      setLastOutcome(finalRecord.status);
      setPhase("settled");
    },
    [teardown],
  );

  const finalizeRef = useRef(finalize);
  finalizeRef.current = finalize;

  /* ------------------------------------------------------------- updates -- */

  const handleUpdate = useCallback((update: StreamUpdate) => {
    switch (update.kind) {
      case "transport":
        setTransport(update.transport);
        setTransportNote(update.detail ?? null);
        break;

      case "event":
        setEvents((current) => {
          if (current.some((event) => event.id === update.event.id)) return current;
          const next = [...current, update.event];
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
        break;

      case "task":
        setTask(update.task);
        if (isTerminalStatus(update.task.status) && !settledRef.current) {
          settledRef.current = true;
          void finalizeRef.current(update.task);
        }
        break;

      case "error":
        setError(update.message);
        break;
    }
  }, []);

  /* ---------------------------------------------------------------- start -- */

  const start = useCallback(
    async (nextPrompt: string) => {
      const trimmed = nextPrompt.trim();
      if (!trimmed) return;

      teardown();
      settledRef.current = false;
      setPrompt(trimmed);
      setEvents([]);
      setError(null);
      setTransport("closed");
      setTransportNote(null);
      setCancelState("idle");
      setLastOutcome(null);
      setTask(null);
      setPhase("submitting");

      let taskId: string;
      try {
        const result = await submitTask(trimmed);
        taskId = result.taskId;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The task could not be submitted.");
        setPhase("idle");
        return;
      }

      taskIdRef.current = taskId;
      setPhase("active");

      if (latest.current.isDemo) {
        // Frames are a backend concern; nothing to probe in demo mode.
      } else {
        void service.getTask(taskId).then(
          (seed) => setTask(seed),
          () => undefined,
        );
        void service.getTaskFrames(taskId).catch(() => ({ framesUrl: null, snapshotUrl: null }));
      }

      const session = openStream(taskId, trimmed, handleUpdate);
      sessionRef.current = session;
      session.start();
    },
    [handleUpdate, openStream, service, submitTask, teardown],
  );

  /* ----------------------------------------------------------------- stop -- */

  const stop = useCallback(async () => {
    const taskId = taskIdRef.current;
    if (!taskId) return;

    if (latest.current.isDemo) {
      // There is no backend to call: stop the local simulation and label it as
      // such in the UI rather than pretending a cancel request was issued.
      setCancelState("stopped");
      teardown();
      setTask((current) => (current ? { ...current, status: "cancelled", completedAt: new Date().toISOString() } : current));
      setEvents((current) => [
        ...current,
        {
          id: `${taskId}-cancelled`,
          taskId,
          type: "task_cancelled",
          message: "Simulation stopped locally.",
          at: new Date().toISOString(),
          origin: "demo" as const,
        },
      ]);
      setLastOutcome("cancelled");
      setPhase("settled");
      return;
    }

    setCancelState("cancelling");
    try {
      const supported = await service.cancelTask(taskId);
      if (!supported) {
        setCancelState("unsupported");
        setError("This backend exposes no cancellation route, so the task cannot be stopped from here yet.");
        return;
      }
      setCancelState("stopped");
      const settled = await service.getTask(taskId).catch(() => null);
      if (settled) setTask(settled);
    } catch (cause) {
      setCancelState("idle");
      setError(cause instanceof Error ? cause.message : "The task could not be stopped.");
    }
  }, [service, teardown]);

  /* ---------------------------------------------------------------- reset -- */

  const reset = useCallback(() => {
    teardown();
    settledRef.current = false;
    taskIdRef.current = null;
    setPhase("idle");
    setTask(null);
    setEvents([]);
    setError(null);
    setCancelState("idle");
    setLastOutcome(null);
    setTransport("closed");
    setTransportNote(null);
  }, [teardown]);

  // Switching data source invalidates any run in progress.
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current !== status) {
      previousStatus.current = status;
      reset();
    }
  }, [status, reset]);

  const canStop = phase === "active" && task !== null && !isTerminalStatus(task.status);

  return {
    phase,
    task,
    prompt,
    events,
    transport,
    transportNote,
    error,
    cancelState,
    lastOutcome,
    start,
    stop,
    reset,
    canCancel: canStop,
  };
}