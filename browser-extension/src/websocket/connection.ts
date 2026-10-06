export interface WebSocketConnectionOptions {
  url: string;
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (error: unknown) => void;
  /** Interval between client heartbeats while the socket is open. */
  heartbeatMs?: number;
  /** Largest number of outbound frames queued while the socket reconnects. */
  maxOutbox?: number;
}

export type WebSocketConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

const DEFAULT_HEARTBEAT_MS = 20000;
const DEFAULT_MAX_OUTBOX = 64;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/**
 * A resilient WebSocket client for the AgentWebEinh bridge.
 *
 * Reconnects with exponential backoff (plus jitter) until told to disconnect,
 * heartbeats while open, and keeps a bounded outbox so a result produced while
 * the socket is reconnecting is not silently dropped.
 */
export class WebSocketConnection {
  private socket: WebSocket | null = null;
  private state: WebSocketConnectionState = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private outbox: string[] = [];

  constructor(readonly options: WebSocketConnectionOptions) {}

  getState(): WebSocketConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.socket) return;
    this.stopped = false;
    this.open();
  }

  /** Permanently tears the connection down; does not reconnect. */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHeartbeat();
    this.outbox = [];
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.setState('closed');
      try {
        socket.close();
      } catch {
        // Already closing or closed — nothing to do.
      }
    }
  }

  send(payload: unknown): void {
    let text: string;
    try {
      text = JSON.stringify(payload);
    } catch {
      this.options.onError?.(new Error('Unable to serialize message'));
      return;
    }
    if (this.state === 'open' && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(text);
      return;
    }
    if (this.outbox.length < (this.options.maxOutbox ?? DEFAULT_MAX_OUTBOX)) {
      this.outbox.push(text);
    }
  }

  // ---------------------------------------------------------------- internal --

  private setState(state: WebSocketConnectionState): void {
    this.state = state;
  }

  private open(): void {
    this.setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.onSocketError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.onSocketOpen(socket);
    socket.onmessage = (event) => this.onSocketMessage(socket, event);
    socket.onclose = (event) => this.onSocketClose(event);
    socket.onerror = () => {
      // The close event always follows; reconnect handling lives in onclose.
    };
  }

  private onSocketOpen(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.reconnectAttempt = 0;
    this.setState('open');
    this.flushOutbox();
    this.startHeartbeat();
    this.options.onOpen?.();
  }

  private onSocketMessage(socket: WebSocket, event: MessageEvent): void {
    if (socket !== this.socket) return;
    let data: unknown;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    this.options.onMessage?.(data);
  }

  private onSocketClose(event: CloseEvent): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSING && this.socket.readyState !== WebSocket.CLOSED) {
      return;
    }
    this.clearHeartbeat();
    if (this.socket) {
      this.socket = null;
      this.setState('closed');
    }
    this.options.onClose?.(event);
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private onSocketError(error: Error): void {
    this.options.onError?.(error);
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    const base = Math.min(BASE_BACKOFF_MS * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    const jitter = Math.floor(base * (0.5 + Math.random() * 0.5));
    this.reconnectAttempt += 1;
    if (this.socket) {
      this.socket = null;
      this.setState('closed');
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.open();
    }, jitter);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state === 'open' && this.socket?.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // The close handler owns cleanup.
        }
      }
    }, this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private flushOutbox(): void {
    if (this.state !== 'open' || !this.socket) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const text of queued) {
      try {
        this.socket.send(text);
      } catch {
        this.outbox.push(text);
        return;
      }
    }
  }
}