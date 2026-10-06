import { EXTENSION_NAME, EXTENSION_PHASE, EXTENSION_SUBTITLE, type StatusPayload } from '../types';
import { COMMAND, isCommandMessage, type CommandMessage, type CommandResult } from '../protocol/commands';
import { isBrowserCommandEnvelope } from '../protocol/browser-commands';
import { failResult, type BrowserResult } from '../protocol/results';
import { createStatusChanged } from '../protocol/events';
import { BrowserController } from '../browser/controller';
import { WireBridge } from '../websocket/bridge';

const controller = new BrowserController();
const bridge = new WireBridge();

function buildStatus(): StatusPayload {
  return {
    name: EXTENSION_NAME,
    phase: EXTENSION_PHASE,
    subtitle: EXTENSION_SUBTITLE,
    status: bridge.isPaired() ? 'Paired' : 'Ready',
    connection: bridge.isPaired() ? 'ready' : 'disconnected',
    timestamp: Date.now(),
    connected: bridge.isPaired(),
    paired: bridge.isPaired(),
    browserId: bridge.getBrowserId(),
    backendUrl: bridge.getBackendUrl(),
    pairing: bridge.getPairingState(),
    lastError: bridge.getLastError(),
  };
}

async function handleCommand(message: CommandMessage): Promise<CommandResult> {
  const base = { requestId: message.requestId, ok: true as const, type: message.type as never };

  switch (message.type) {
    case COMMAND.PING:
      return { ...base, payload: { pong: true, timestamp: Date.now() } };
    case COMMAND.GET_STATUS:
      return { ...base, payload: buildStatus() };
    case COMMAND.SET_BACKEND_URL: {
      const url = (message.payload as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string' || !url.trim()) {
        return { ...base, ok: false, error: 'SET_BACKEND_URL requires a string "url" payload' };
      }
      await bridge.setBackendUrl(url);
      return { ...base, payload: { url: bridge.getBackendUrl() } };
    }
    case COMMAND.PAIR: {
      const code = (message.payload as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || !code.trim()) {
        return { ...base, ok: false, error: 'PAIR requires a string "code" payload' };
      }
      await bridge.pair(code);
      return { ...base, payload: { pairing: bridge.isPaired() ? 'paired' : 'waiting' } };
    }
    case COMMAND.UNPAIR:
      await bridge.unpair();
      return { ...base, payload: { paired: false } };
    default:
      return { ...base, ok: false, error: `Unknown command: ${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isCommandMessage(message)) {
    void handleCommand(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          requestId: message.requestId,
          ok: false,
          type: message.type,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (isBrowserCommandEnvelope(message)) {
    // Browser commands execute asynchronously; the channel stays open until
    // the controller resolves with a structured BrowserResult. A failing
    // command never rejects — it resolves to a failure result.
    controller
      .execute(message.command, message.requestId)
      .then((result: BrowserResult) => sendResponse(result))
      .catch((error: unknown) => {
        sendResponse(
          failResult('INTERNAL', message.requestId, {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void bridge.start();
  const status = buildStatus();
  chrome.runtime.sendMessage(createStatusChanged(status)).catch(() => {
    // No listeners yet (e.g. fresh install with popup closed) — expected.
  });
});

void bridge.start();

console.log(`${EXTENSION_NAME} ${EXTENSION_PHASE}: service worker started`);
