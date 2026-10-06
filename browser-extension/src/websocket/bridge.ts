import { BrowserController } from '../browser/controller';
import { createConnectionChanged, type ConnectionChangedEvent } from '../protocol/events';
import { EXTENSION_NAME } from '../types';
import { WebSocketConnection } from './connection';

const STORAGE_KEY_BACKEND_URL = 'backendUrl';
const STORAGE_KEY_PAIRING_CODE = 'pairingCode';

export const DEFAULT_BACKEND_URL = 'ws://127.0.0.1:8001/api/browser/ws';
const FRAME_INTERVAL_MS = 1200;

interface ServerMessage {
  type?: unknown;
  [key: string]: unknown;
}

export interface BridgeStatusEvent {
  connected: boolean;
  pairing: 'idle' | 'waiting' | 'paired' | 'rejected' | 'error';
  browserId: string | null;
  connectionId: string | null;
  backendUrl: string;
  lastError: string | null;
}

/**
 * Links the WebSocket to the backend and the BrowserController back to it.
 *
 * Lifecycle:
 * 1. ``start()`` loads the persisted backend URL + pairing code and connects.
 * 2. When the socket opens with a code stored, ``{type: "pair"}`` is sent.
 * 3. ``paired`` answers are stored for this socket; ``browser_command`` frames
 *    run through ``BrowserController`` and the resulting ``BrowserResult`` is
 *    sent back as ``browser_result`` with the matching ``action_id``.
 * 4. A `stop` frame cancels the current action; a rejected code is cleared so
 *    the socket does not reconnect on a broken credential forever.
 */
export class WireBridge {
  private connection: WebSocketConnection | null = null;
  private controller = new BrowserController();
  private backendUrl = DEFAULT_BACKEND_URL;
  private pairingCode: string | null = null;
  private browserId: string | null = null;
  private connectionId: string | null = null;
  private pairingState: BridgeStatusEvent['pairing'] = 'idle';
  private lastError: string | null = null;
  private started = false;
  private activeTaskId: string | null = null;
  private frameInterval: ReturnType<typeof setInterval> | undefined;

  // ------------------------------------------------------------- lifecycle --

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadSettings();
    this.connect();
  }

  async shutdown(): Promise<void> {
    this.started = false;
    this.pairingState = 'idle';
    this.browserId = null;
    this.connectionId = null;
    this.activeTaskId = null;
    this.stopFrameLoop();
    this.connection?.disconnect();
    this.broadcast();
  }

  getBackendUrl(): string {
    return this.backendUrl;
  }

  getBrowserId(): string | null {
    return this.browserId;
  }

  getPairingState(): BridgeStatusEvent['pairing'] {
    return this.pairingState;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  isPaired(): boolean {
    return this.browserId !== null && this.connectionId !== null;
  }

  // ------------------------------------------------------------ bridge ops --

  async setBackendUrl(url: string): Promise<void> {
    const next = normalizeWsUrl(url) ?? this.backendUrl;
    if (next === this.backendUrl) return;
    this.backendUrl = next;
    await chrome.storage.local.set({ [STORAGE_KEY_BACKEND_URL]: this.backendUrl });
    this.resetPairing();
    this.connect();
  }

  async pair(code: string): Promise<void> {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    this.pairingCode = normalized;
    this.lastError = null;
    this.pairingState = this.connection?.getState() === 'open' ? 'waiting' : 'idle';
    await chrome.storage.local.set({ [STORAGE_KEY_PAIRING_CODE]: this.pairingCode });
    if (this.connection?.getState() === 'open') {
      this.sendPair();
    } else {
      this.connect();
    }
    this.broadcast();
  }

  async unpair(): Promise<void> {
    this.pairingCode = null;
    this.browserId = null;
    this.connectionId = null;
    this.pairingState = 'idle';
    await chrome.storage.local.remove(STORAGE_KEY_PAIRING_CODE);
    this.broadcast();
  }

  async clearError(): Promise<void> {
    this.lastError = null;
    this.broadcast();
  }

  // -------------------------------------------------------------- internal --

  private async loadSettings(): Promise<void> {
    const stored = await chrome.storage.local.get([STORAGE_KEY_BACKEND_URL, STORAGE_KEY_PAIRING_CODE]);
    const rawUrl = stored[STORAGE_KEY_BACKEND_URL];
    if (typeof rawUrl === 'string' && rawUrl.trim()) {
      const normalized = normalizeWsUrl(rawUrl);
      if (normalized) this.backendUrl = normalized;
    }
    const rawCode = stored[STORAGE_KEY_PAIRING_CODE];
    if (typeof rawCode === 'string' && rawCode.trim()) {
      this.pairingCode = rawCode.trim().toUpperCase();
    }
  }

  private resetPairing(): void {
    this.browserId = null;
    this.connectionId = null;
    this.pairingState = 'idle';
  }

  private connect(): void {
    this.connection?.disconnect();
    const connection = new WebSocketConnection({
      url: this.backendUrl,
      onOpen: () => this.onOpen(),
      onMessage: (data) => this.onMessage(data),
      onClose: () => this.onClose(),
      onError: () => this.onError(),
    });
    this.connection = connection;
    connection.connect();
    this.broadcast();
  }

  private sendPair(): void {
    if (!this.pairingCode) return;
    this.pairingState = 'waiting';
    const name = chrome.runtime.getManifest().name ?? EXTENSION_NAME;
    // Chrome's extension id is stable per install: the backend uses it to let
    // *this* extension re-pair after a dropped socket while still refusing any
    // other client holding the same (already used) code.
    this.connection?.send({
      type: 'pair',
      code: this.pairingCode,
      name,
      extension_id: chrome.runtime.id,
    });
    this.broadcast();
  }

  // -------------------------------------------------------------- socket -- 

  private onOpen(): void {
    if (this.pairingCode) {
      this.sendPair();
    } else {
      this.broadcast();
    }
  }

  private onClose(): void {
    if (this.browserId) {
      this.browserId = null;
      this.connectionId = null;
      this.pairingState = 'idle';
    }
    this.activeTaskId = null;
    this.stopFrameLoop();
    this.broadcast();
  }

  private onError(): void {
    this.lastError = 'Unable to reach the backend. Check the backend URL and that it is running.';
    this.broadcast();
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as ServerMessage;
    switch (message.type) {
      case 'paired':
        this.onPaired(message);
        break;
      case 'pong':
        break;
      case 'browser_command':
        void this.onBrowserCommand(message);
        break;
      case 'stop':
        this.onStop(message);
        break;
      case 'error':
        this.onServerError(message);
        break;
      default:
        break;
    }
  }

  private onPaired(message: ServerMessage): void {
    this.browserId = typeof message.browser_id === 'string' ? message.browser_id : null;
    this.connectionId = typeof message.connection_id === 'string' ? message.connection_id : null;
    this.pairingState = this.browserId && this.connectionId ? 'paired' : 'error';
    this.lastError = null;
    this.broadcast();
  }

  private onServerError(message: ServerMessage): void {
    const code = typeof message.code === 'string' ? message.code : 'error';
    const text = typeof message.message === 'string' ? message.message : String(message.message ?? code);
    if (code === 'pairing_rejected') {
      this.pairingState = 'rejected';
      this.pairingCode = null;
      void chrome.storage.local.remove(STORAGE_KEY_PAIRING_CODE);
    } else {
      this.pairingState = 'error';
    }
    this.lastError = text;
    this.broadcast();
  }

  private async onBrowserCommand(message: ServerMessage): Promise<void> {
    const taskId = typeof message.task_id === 'string' ? message.task_id : '';
    const actionId = typeof message.action_id === 'string' ? message.action_id : '';
    const connectionId = typeof message.connection_id === 'string' ? message.connection_id : '';
    if (!taskId || !actionId || connectionId !== this.connectionId) return;

    this.activeTaskId = taskId;
    this.startFrameLoop();
    const result = await this.controller.execute(message.command, actionId);
    this.sendResult(taskId, actionId, result);
  }

  private onStop(message: ServerMessage): void {
    const taskId = typeof message.task_id === 'string' ? message.task_id : '';
    this.activeTaskId = null;
    this.stopFrameLoop();
    this.controller.execute({ command: 'STOP' }, `stop:${taskId || 'task'}:${Date.now()}`).catch(() => {
      // STOP resolves to a result; nothing to do on failure.
    });
  }

  private sendResult(
    taskId: string,
    actionId: string,
    result: { success: boolean; data?: unknown; error?: unknown },
  ): void {
    const payload: Record<string, unknown> = {
      type: 'browser_result',
      task_id: taskId,
      action_id: actionId,
      connection_id: this.connectionId,
      success: result.success,
    };
    if (result.success) {
      payload.data = result.data;
    } else {
      payload.error = result.error;
    }
    this.connection?.send(payload);
  }

  // ------------------------------------------------------------- broadcast --

  private startFrameLoop(): void {
    this.stopFrameLoop();
    if (!this.isPaired()) return;
    this.frameInterval = setInterval(() => {
      void this.captureAndSendFrame();
    }, FRAME_INTERVAL_MS);
  }

  private stopFrameLoop(): void {
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = undefined;
    }
  }

  private async captureAndSendFrame(): Promise<void> {
    if (!this.isPaired() || !this.activeTaskId) return;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.id === undefined || tab.windowId === undefined) return;

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 80,
      });
      if (typeof dataUrl !== 'string') return;

      this.connection?.send({
        type: 'browser_event',
        event: 'frame',
        task_id: this.activeTaskId,
        data: {
          image: dataUrl,
          url: tab.url,
          title: tab.title,
        },
      });
    } catch (err) {
      // Silently ignore frame capture errors
    }
  }

  private broadcast(): void {
    const event: ConnectionChangedEvent = createConnectionChanged({
      connected: this.connection?.getState() === 'open',
      pairing: this.pairingState,
      browserId: this.browserId,
      connectionId: this.connectionId,
      backendUrl: this.backendUrl,
      lastError: this.lastError,
    });
    void chrome.runtime.sendMessage(event).catch(() => {
      // No listeners (popup closed) — expected.
    });
  }
}

function normalizeWsUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/api/browser/ws';
  }
  return url.href.replace(/\/$/, '');
}