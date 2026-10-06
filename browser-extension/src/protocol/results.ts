import type { BrowserCommandName, ScrollDirection, TargetSpec } from './browser-commands';
import type { ElementInfo } from './page-ops';
import type { BrowserError } from './errors';

export type { ElementInfo };

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
}

export interface ClickData {
  target: TargetSpec;
  url: string;
  title: string;
}

export interface TypeData {
  target: TargetSpec;
  url: string;
  title: string;
  length: number;
}

export interface ScrollData {
  direction: ScrollDirection;
  amount: number;
  scrollX: number;
  scrollY: number;
}

export interface GetPageData {
  tabId: number;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  headings: string[];
  elements: ElementInfo[];
}

export interface ScreenshotData {
  tabId: number;
  url: string;
  title: string;
  format: 'jpeg' | 'png';
  dataUrl: string;
  byteLength: number;
  capturedAt: number;
}

export interface StopData {
  stopRequested: true;
  hadActiveAction: boolean;
}

export interface BrowserDataMap {
  OPEN_URL: TabInfo;
  NEW_TAB: TabInfo;
  BACK: TabInfo;
  CLICK: ClickData;
  TYPE: TypeData;
  SCROLL: ScrollData;
  GET_PAGE: GetPageData;
  SCREENSHOT: ScreenshotData;
  STOP: StopData;
}

export interface SuccessResult<C extends BrowserCommandName = BrowserCommandName> {
  success: true;
  command: C;
  requestId: string;
  timestamp: number;
  data: BrowserDataMap[C];
}

export interface FailureResult {
  success: false;
  command: string;
  requestId: string;
  timestamp: number;
  error: BrowserError;
}

export type BrowserResult<C extends BrowserCommandName = BrowserCommandName> =
  | SuccessResult<C>
  | FailureResult;

export function okResult<C extends BrowserCommandName>(
  command: C,
  requestId: string,
  data: BrowserDataMap[C],
): SuccessResult<C> {
  return { success: true, command, requestId, timestamp: Date.now(), data };
}

export function failResult(command: string, requestId: string, error: BrowserError): FailureResult {
  return { success: false, command, requestId, timestamp: Date.now(), error };
}
