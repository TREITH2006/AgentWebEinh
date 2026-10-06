import type { BrowserCommand } from '../protocol/browser-commands';
import { parseBrowserCommand } from '../protocol/browser-commands';
import { MAX_PAGE_TEXT_CHARS } from '../protocol/page-ops';
import {
  failResult,
  okResult,
  type BrowserDataMap,
  type BrowserResult,
  type ScreenshotData,
} from '../protocol/results';
import { sendPageOp } from './content-channel';
import { BrowserCommandError, throwIfCancelled, toBrowserError, type CancelToken } from './errors';
import { getActiveTab, getTab, toTabInfo, waitForSettle } from './tabs';

interface ActiveAction {
  command: BrowserCommand['command'];
  token: CancelToken;
  startedAt: number;
}

/**
 * Executes validated browser commands against the local Chrome instance.
 * Commands run one at a time on an internal queue; STOP cancels the active
 * command's token and invalidates commands still waiting in the queue.
 */
export class BrowserController {
  private active: ActiveAction | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopGeneration = 0;

  execute(rawCommand: unknown, requestId: string): Promise<BrowserResult> {
    const parsed = parseBrowserCommand(rawCommand);
    if (!parsed.ok) {
      const name =
        typeof rawCommand === 'object' &&
        rawCommand !== null &&
        typeof (rawCommand as { command?: unknown }).command === 'string'
          ? String((rawCommand as { command: string }).command)
          : 'INVALID';
      return Promise.resolve(failResult(name, requestId, parsed.error));
    }

    const command = parsed.command;
    if (command.command === 'STOP') {
      return Promise.resolve(this.stop(requestId));
    }

    const generation = this.stopGeneration;
    const run = async (): Promise<BrowserResult> => {
      if (generation !== this.stopGeneration) {
        return failResult(command.command, requestId, {
          code: 'CANCELLED',
          message: `${command.command} cancelled by STOP before it started`,
        });
      }
      const token: CancelToken = { cancelled: false };
      const action: ActiveAction = { command: command.command, token, startedAt: Date.now() };
      this.active = action;
      try {
        const data = await this.dispatch(command, token, requestId);
        return okResult(command.command, requestId, data);
      } catch (error) {
        return failResult(command.command, requestId, toBrowserError(error));
      } finally {
        if (this.active === action) this.active = null;
      }
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private stop(requestId: string): BrowserResult {
    this.stopGeneration += 1;
    const hadActiveAction = this.active !== null;
    if (this.active) {
      this.active.token.cancelled = true;
    }
    return okResult('STOP', requestId, { stopRequested: true, hadActiveAction });
  }

  private async dispatch(
    command: BrowserCommand,
    token: CancelToken,
    requestId: string,
  ): Promise<Exclude<BrowserDataMap[BrowserCommand['command']], BrowserDataMap['STOP']>> {
    switch (command.command) {
      case 'OPEN_URL':
        return this.openUrl(command.url, token);
      case 'NEW_TAB':
        return this.newTab(command.url, token);
      case 'BACK':
        return this.back(token);
      case 'CLICK':
        return this.click(command.target, token, requestId);
      case 'TYPE':
        return this.typeInto(command.target, command.text, token, requestId);
      case 'SCROLL':
        return this.scroll(command.direction, command.amount, token, requestId);
      case 'GET_PAGE':
        return this.getPage(token, requestId);
      case 'SCREENSHOT':
        return this.screenshot(command.format, token);
      case 'STOP':
        throw new BrowserCommandError('INTERNAL_ERROR', 'STOP is handled outside dispatch');
    }
  }

  private async openUrl(url: string, token: CancelToken): Promise<BrowserDataMap['OPEN_URL']> {
    const tab = await getActiveTab();
    throwIfCancelled(token);
    try {
      await chrome.tabs.update(tab.id, { url });
    } catch (error) {
      throw new BrowserCommandError(
        'NAVIGATION_FAILURE',
        `Failed to navigate to ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const settled = await waitForSettle(tab.id, token, tab.url);
    return toTabInfo(settled);
  }

  private async newTab(url: string | undefined, token: CancelToken): Promise<BrowserDataMap['NEW_TAB']> {
    throwIfCancelled(token);
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create(url !== undefined ? { url } : {});
    } catch (error) {
      throw new BrowserCommandError(
        'NAVIGATION_FAILURE',
        `Failed to create tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (tab.id === undefined) {
      throw new BrowserCommandError('TAB_NOT_FOUND', 'Created tab has no id');
    }
    if (url !== undefined) {
      const settled = await waitForSettle(tab.id, token);
      return toTabInfo(settled);
    }
    return toTabInfo(tab);
  }

  private async back(token: CancelToken): Promise<BrowserDataMap['BACK']> {
    const tab = await getActiveTab();
    throwIfCancelled(token);
    try {
      await chrome.tabs.goBack(tab.id);
    } catch (error) {
      throw new BrowserCommandError(
        'NAVIGATION_FAILURE',
        `Tab cannot go back (no history entry): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const settled = await waitForSettle(tab.id, token, tab.url);
    return toTabInfo(settled);
  }

  private async click(
    target: BrowserDataMap['CLICK']['target'],
    token: CancelToken,
    requestId: string,
  ): Promise<BrowserDataMap['CLICK']> {
    const tab = await getActiveTab();
    const data = await sendPageOp(tab.id, 'CLICK', { target }, token, `${requestId}:click`);
    const settled = await getTab(tab.id);
    return { target, url: data.url || settled.url || '', title: data.title || settled.title || '' };
  }

  private async typeInto(
    target: BrowserDataMap['TYPE']['target'],
    text: string,
    token: CancelToken,
    requestId: string,
  ): Promise<BrowserDataMap['TYPE']> {
    const tab = await getActiveTab();
    const data = await sendPageOp(tab.id, 'TYPE', { target, text }, token, `${requestId}:type`);
    const settled = await getTab(tab.id);
    return {
      target,
      url: data.url || settled.url || '',
      title: data.title || settled.title || '',
      length: data.length,
    };
  }

  private async scroll(
    direction: BrowserDataMap['SCROLL']['direction'],
    amount: number,
    token: CancelToken,
    requestId: string,
  ): Promise<BrowserDataMap['SCROLL']> {
    const tab = await getActiveTab();
    const data = await sendPageOp(tab.id, 'SCROLL', { direction, amount }, token, `${requestId}:scroll`);
    return { direction, amount, scrollX: data.scrollX, scrollY: data.scrollY };
  }

  private async getPage(token: CancelToken, requestId: string): Promise<BrowserDataMap['GET_PAGE']> {
    const tab = await getActiveTab();
    const data = await sendPageOp(tab.id, 'GET_PAGE', undefined, token, `${requestId}:get_page`);
    const bounded = data.text.slice(0, MAX_PAGE_TEXT_CHARS);
    return {
      tabId: tab.id,
      url: data.url,
      title: data.title,
      text: bounded,
      truncated: data.truncated || data.text.length > MAX_PAGE_TEXT_CHARS,
      headings: data.headings ?? [],
      elements: data.elements ?? [],
    };
  }

  private async screenshot(
    format: 'jpeg' | 'png',
    token: CancelToken,
  ): Promise<ScreenshotData> {
    const tab = await getActiveTab();
    throwIfCancelled(token);
    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(
        tab.windowId,
        format === 'png' ? { format: 'png' } : { format: 'jpeg', quality: 80 },
      );
    } catch (error) {
      throw new BrowserCommandError(
        'SCREENSHOT_FAILURE',
        `Unable to capture the visible tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new BrowserCommandError('SCREENSHOT_FAILURE', 'Capture returned no image data');
    }
    throwIfCancelled(token);
    const comma = dataUrl.indexOf(',');
    const payloadLength = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
    return {
      tabId: tab.id,
      url: tab.url ?? '',
      title: tab.title ?? '',
      format,
      dataUrl,
      byteLength: Math.floor((payloadLength * 3) / 4),
      capturedAt: Date.now(),
    };
  }
}
