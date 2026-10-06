import { COMMAND, type CommandResult } from '../protocol/commands';
import { isConnectionChangedEvent, type ConnectionStatePayload } from '../protocol/events';

const statusEl = document.getElementById('status');
const backendUrlEl = document.getElementById('backend-url') as HTMLInputElement | null;
const pairingCodeEl = document.getElementById('pairing-code') as HTMLInputElement | null;
const pairBtn = document.getElementById('pair') as HTMLButtonElement | null;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement | null;
const metaEl = document.getElementById('meta');
const errorLineEl = document.getElementById('error-line');
const linkStatus = document.getElementById('link-status');

// Once the user edits the backend URL it must never be clobbered by a status
// event that arrives afterwards, or the pair action would silently target the
// previously stored URL instead of the one they entered.
let backendEdited = false;

function sendCommand(message: { type: string; requestId: string; payload?: unknown }): Promise<CommandResult | undefined> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

function render(state: ConnectionStatePayload | null): void {
  let pairing: ConnectionStatePayload['pairing'] = 'idle';
  let backendUrl = '';
  if (state) {
    pairing = state.pairing;
    backendUrl = state.backendUrl;
  }

  let text = 'Status: checking…';
  let cls = 'status';
  if (pairing === 'paired') {
    text = 'Status: paired';
    cls += ' connected';
  } else if (pairing === 'waiting') {
    text = 'Status: waiting for the backend…';
    cls += ' waiting';
  } else if (pairing === 'rejected') {
    text = 'Status: pairing rejected';
    cls += ' rejected';
  } else if (pairing === 'error') {
    text = 'Status: connection error';
    cls += ' error';
  } else if (state && !state.connected) {
    text = 'Status: disconnected';
    cls += ' error';
  } else if (pairing === 'idle' && state?.connected) {
    text = 'Status: connected, not paired';
    cls += ' waiting';
  }

  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  if (backendUrlEl && backendUrl && !backendEdited) backendUrlEl.value = backendUrl;
  if (pairBtn) {
    pairBtn.disabled = pairing === 'paired' || pairing === 'waiting';
    pairBtn.textContent = pairing === 'paired' ? 'Paired' : 'Pair browser';
  }
  if (disconnectBtn) disconnectBtn.disabled = pairing !== 'paired';
  if (errorLineEl) {
    const message = state?.lastError || '';
    errorLineEl.textContent = message || (state?.pairing === 'rejected' ? 'That code was rejected. Enter a fresh one from the website.' : '');
  }
  if (metaEl) {
    metaEl.textContent = state
      ? `backend: ${backendUrl}${state.browserId ? ` · browser: ${state.browserId}` : ''}`
      : 'backend: unknown';
  }
}

async function refresh(): Promise<void> {
  const response = await sendCommand({ type: COMMAND.GET_STATUS, requestId: `popup-status-${Date.now()}` });
  render(
    response?.ok && typeof response.payload === 'object' && response.payload !== null
      ? (response.payload as unknown as ConnectionStatePayload)
      : null,
  );
}

function wire(): void {
  backendUrlEl?.addEventListener('input', () => {
    backendEdited = true;
  });
  backendUrlEl?.addEventListener('change', () => {
    backendEdited = true;
    const url = backendUrlEl.value.trim();
    if (!url) return;
    void sendCommand({ type: COMMAND.SET_BACKEND_URL, requestId: `popup-url-${Date.now()}`, payload: { url } });
  });

  pairBtn?.addEventListener('click', () => {
    const code = pairingCodeEl?.value.trim() ?? '';
    if (code.length < 8) return;
    void sendCommand({ type: COMMAND.PAIR, requestId: `popup-pair-${Date.now()}`, payload: { code } });
  });

  disconnectBtn?.addEventListener('click', () => {
    void sendCommand({ type: COMMAND.UNPAIR, requestId: `popup-unpair-${Date.now()}` });
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (isConnectionChangedEvent(message)) render(message.status);
    return false;
  });

  void refresh();
}

async function pingBackground(): Promise<void> {
  if (!linkStatus) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: COMMAND.PING, requestId: `popup-${Date.now()}` });
    linkStatus.textContent = (response as CommandResult | undefined)?.ok ? 'background: connected' : 'background: no reply';
  } catch {
    linkStatus.textContent = 'background: unavailable';
  }
}

wire();
void pingBackground();