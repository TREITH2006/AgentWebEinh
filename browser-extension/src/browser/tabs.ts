import type { TabInfo } from '../protocol/results';
import { BrowserCommandError, throwIfCancelled, type CancelToken } from './errors';

const POLL_INTERVAL_MS = 100;
const DEFAULT_SETTLE_TIMEOUT_MS = 15000;
const URL_CHANGE_GRACE_MS = 1500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  if (tab.id === undefined) {
    throw new BrowserCommandError('TAB_NOT_FOUND', 'Tab has no id');
  }
  return { tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '' };
}

export async function getActiveTab(): Promise<chrome.tabs.Tab & { id: number }> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    throw new BrowserCommandError('TAB_NOT_FOUND', `Unable to query tabs: ${String(error)}`);
  }
  const tab = tabs[0];
  if (!tab || tab.id === undefined) {
    throw new BrowserCommandError('TAB_NOT_FOUND', 'No active tab is available');
  }
  return tab as chrome.tabs.Tab & { id: number };
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new BrowserCommandError('TAB_NOT_FOUND', `Tab ${tabId} no longer exists`);
  }
}

/**
 * Waits until the tab is loading-complete after a navigation. When
 * `initialUrl` is provided, also waits for the URL (or loading state) to
 * change first so a still-settling previous page is not observed as final.
 */
export async function waitForSettle(
  tabId: number,
  token: CancelToken,
  initialUrl?: string,
  timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let navigationObserved = initialUrl === undefined;

  while (true) {
    throwIfCancelled(token);
    const tab = await getTab(tabId);

    if (!navigationObserved) {
      if (tab.url !== initialUrl || tab.status !== 'complete') {
        navigationObserved = true;
      } else if (Date.now() > deadline - timeoutMs + URL_CHANGE_GRACE_MS && tab.status === 'complete') {
        // Some navigations (same URL) never leave "complete"; after a short
        // grace period treat the current state as the result.
        navigationObserved = true;
      }
    }

    if (navigationObserved && tab.status === 'complete') {
      return tab;
    }
    if (Date.now() > deadline) {
      throw new BrowserCommandError(
        'PAGE_NOT_READY',
        `Tab ${tabId} did not settle within ${timeoutMs}ms`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
