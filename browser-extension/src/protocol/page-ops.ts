import type { ScrollDirection, TargetSpec } from './browser-commands';
import type { BrowserError } from './errors';

export const MAX_PAGE_TEXT_CHARS = 15000;
export const MAX_PAGE_HEADINGS = 30;
export const MAX_PAGE_ELEMENTS = 60;
export const PAGE_OP_TIMEOUT_MS = 10000;

export type PageOpName = 'PING' | 'CLICK' | 'TYPE' | 'SCROLL' | 'GET_PAGE';

export interface ElementInfo {
  index: number;
  selector: string;
  tag: string;
  role: string | null;
  text: string;
}

export interface PageOpPayloads {
  PING: undefined;
  CLICK: { target: TargetSpec };
  TYPE: { target: TargetSpec; text: string };
  SCROLL: { direction: ScrollDirection; amount: number };
  GET_PAGE: undefined;
}

export interface PageOpRequest<N extends PageOpName = PageOpName> {
  type: 'PAGE_OP';
  op: N;
  requestId: string;
  payload?: PageOpPayloads[N];
}

export interface PageOpResultData {
  PING: { pong: true };
  CLICK: { url: string; title: string };
  TYPE: { url: string; title: string; length: number };
  SCROLL: { scrollX: number; scrollY: number };
  GET_PAGE: {
    url: string;
    title: string;
    text: string;
    truncated: boolean;
    headings: string[];
    elements: ElementInfo[];
  };
}

export type PageOpResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: BrowserError };

