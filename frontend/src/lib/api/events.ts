/* =============================================================================
   Live task event stream
   -----------------------------------------------------------------------------
   Transport: WebSocket by default, with automatic fallback to status polling.
   The stream is intentionally dumb — it emits normalised `StreamUpdate`s and the
   `useTaskRunner` hook owns all state.

   It also reports a `transport` so the UI can say exactly how updates are
   arriving ("live" / "polling") rather than implying a websocket that is not there.
   ============================================================================= */

import { API_CONFIG, apiWsUrl } from "../config";
import { API_ENDPOINTS } from "./endpoints";
import { normalizeEvent, normalizeTask } from "./normalize";
import type { AgentEvent, DataOrigin, TaskRecord } from "@/types/domain";
import type { TaskStreamMessage } from "@/types/api";
import { fetchTask } from "./tasks";

export type StreamTransport = "websocket" | "polling" | "closed";

export type StreamUpdate =
  | { kind: "transport"; transport: StreamTransport; detail?: string }
  | { kind: "event"; event: AgentEvent }
  | { kind: "task"; task: TaskRecord }
  | { kind: "error"; message: string };

export interface TaskEventStreamOptions {
  taskId: string;
  origin: DataOrigin;
  onUpdate: (update: StreamUpdate) => void;
  pollIntervalMs?: number;
}

const MAX_BACKOFF_MS = 15_000;
const MAX_ATTEMPTS = 4;

export class TaskEventStream {
  private socket: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByCaller = false;
  private lastSeq: number | null = null;

  constructor(private readonly options: TaskEventStreamOptions) {}

  start(): void {
    this.closedByCaller = false;
    this.openSocket();
  }

  close(): void {
    this.closedByCaller = true;
    this.teardown();
    this.options.onUpdate({ kind: "transport", transport: "closed" });
  }

  /* ------------------------------------------------------------- websocket -- */

  private openSocket(): void {
    if (this.closedByCaller) return;
    const url = apiWsUrl(API_ENDPOINTS.taskSocket(this.options.taskId));
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.beginPolling("WebSocket could not be opened.");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.options.onUpdate({ kind: "transport", transport: "websocket" });
      // A snapshot on connect closes the gap between page load and stream start.
      void this.pollOnce();
    };
    socket.onmessage = (message: MessageEvent<string>) => {
      this.handleMessage(message.data);
    };
    socket.onerror = () => {
      // `onclose` always follows; reconnection is handled there.
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.closedByCaller) return;
      if (this.attempts >= MAX_ATTEMPTS) {
        this.beginPolling("Live stream unavailable — falling back to status polling.");
        return;
      }
      const delay = Math.min(600 * 2 ** this.attempts, MAX_BACKOFF_MS);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };
  }

  private handleMessage(raw: string): void {
    let payload: TaskStreamMessage;
    try {
      payload = JSON.parse(raw) as TaskStreamMessage;
    } catch {
      return;
    }
    if (typeof payload !== "object" || payload === null) return;

    // Sequence gaps mean we missed frames: re-sync with a full poll.
    if (typeof payload.seq === "number") {
      if (this.lastSeq !== null && payload.seq > this.lastSeq + 1) void this.pollOnce();
      this.lastSeq = payload.seq;
    }

    const serverTime = typeof payload.serverTime === "string" ? payload.serverTime : new Date().toISOString();

    if (payload.snapshot) {
      this.options.onUpdate({ kind: "task", task: normalizeTask(payload.snapshot, this.options.origin, this.options.taskId) });
    }
    if (payload.event) {
      this.options.onUpdate({
        kind: "event",
        event: normalizeEvent(payload.event, this.options.taskId, this.options.origin, serverTime),
      });
    }
    if (payload.task) {
      this.options.onUpdate({ kind: "task", task: normalizeTask(payload.task, this.options.origin, this.options.taskId) });
    }
  }

  /* ---------------------------------------------------------------- polling -- */

  private beginPolling(detail: string): void {
    if (this.pollTimer) return;
    this.teardownSocket();
    this.options.onUpdate({ kind: "transport", transport: "polling", detail });
    void this.pollOnce();
    const interval = this.options.pollIntervalMs ?? API_CONFIG.pollIntervalMs;
    this.pollTimer = setInterval(() => void this.pollOnce(), interval);
  }

  private async pollOnce(): Promise<void> {
    if (this.closedByCaller) return;
    try {
      const task = await fetchTask(this.options.taskId, this.options.origin);
      this.options.onUpdate({ kind: "task", task });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Lost contact with the service.";
      this.options.onUpdate({ kind: "error", message });
    }
  }

  /* --------------------------------------------------------------- cleanup -- */

  private teardownSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
  }

  private teardown(): void {
    this.teardownSocket();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.attempts = 0;
    this.lastSeq = null;
  }
}