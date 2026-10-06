import {
  PAGE_OP_TIMEOUT_MS,
  type PageOpName,
  type PageOpPayloads,
  type PageOpRequest,
  type PageOpResponse,
  type PageOpResultData,
} from '../protocol/page-ops';
import { BrowserCommandError, throwIfCancelled, type CancelToken } from './errors';

const CONTENT_SCRIPT_FILE = 'content/content-script.js';

function isPageOpResponse(value: unknown): value is PageOpResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PageOpResponse>;
  if (candidate.ok === true) return 'data' in candidate;
  if (candidate.ok === false) {
    const error = (candidate as { error?: unknown }).error;
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { message?: unknown }).message === 'string'
    );
  }
  return false;
}

async function sendToContentScript<N extends PageOpName>(
  tabId: number,
  request: PageOpRequest<N>,
): Promise<PageOpResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      // First attempt failed: the content script may not be present yet
      // (tab opened before install / extension reload). Inject on demand.
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [CONTENT_SCRIPT_FILE],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/permission|cannot access|chrome:\/\//i.test(message)) {
          throw new BrowserCommandError(
            'PERMISSION_FAILURE',
            `Content script injection denied for tab ${tabId}: ${message}`,
          );
        }
        throw new BrowserCommandError(
          'CONTENT_SCRIPT_UNAVAILABLE',
          `Unable to inject content script into tab ${tabId}: ${message}`,
        );
      }
    }

    try {
      const response = (await chrome.tabs.sendMessage(tabId, request)) as unknown;
      if (!isPageOpResponse(response)) {
        throw new BrowserCommandError(
          'CONTENT_SCRIPT_UNAVAILABLE',
          `Tab ${tabId} returned an invalid page-op response`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof BrowserCommandError) throw error;
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new BrowserCommandError(
    'CONTENT_SCRIPT_UNAVAILABLE',
    `No content script responded in tab ${tabId}: ${message}`,
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: 'PAGE_NOT_READY'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BrowserCommandError(code, `Page operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs a PAGE_OP against a tab's content script. Ensures the content script
 * is present (injecting it if needed), enforces a timeout and honours the
 * cancellation token before/after the round trip.
 */
export async function sendPageOp<N extends PageOpName>(
  tabId: number,
  op: N,
  payload: PageOpPayloads[N],
  token: CancelToken,
  requestId: string,
): Promise<PageOpResultData[N]> {
  throwIfCancelled(token);
  const request: PageOpRequest<N> = { type: 'PAGE_OP', op, requestId, payload };

  const response = await withTimeout(sendToContentScript(tabId, request), PAGE_OP_TIMEOUT_MS, 'PAGE_NOT_READY');
  throwIfCancelled(token);

  if (!response.ok) {
    throw new BrowserCommandError(response.error.code, response.error.message);
  }
  return response.data as PageOpResultData[N];
}

