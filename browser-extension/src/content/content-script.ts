import type { ScrollDirection, TargetSpec } from '../protocol/browser-commands';
import { isBrowserErrorCode, makeError } from '../protocol/errors';
import type { ElementInfo, PageOpName, PageOpRequest, PageOpResponse } from '../protocol/page-ops';
import { MAX_PAGE_ELEMENTS, MAX_PAGE_HEADINGS, MAX_PAGE_TEXT_CHARS } from '../protocol/page-ops';

function ok(data: unknown): PageOpResponse {
  return { ok: true, data };
}

function fail(code: string, message: string): PageOpResponse {
  return { ok: false, error: makeError(isBrowserErrorCode(code) ? code : 'INTERNAL_ERROR', message) };
}

function resolveTarget(target: unknown): { ok: true; element: Element } | { ok: false; response: PageOpResponse } {
  if (typeof target !== 'object' || target === null) {
    return { ok: false, response: fail('INVALID_INPUT', 'Target must be an object') };
  }
  const spec = target as Partial<TargetSpec>;
  if (spec.strategy !== undefined && spec.strategy !== 'css') {
    return {
      ok: false,
      response: fail('UNSUPPORTED_OPERATION', `Target strategy "${String(spec.strategy)}" is not supported`),
    };
  }
  if (typeof spec.selector !== 'string' || spec.selector.trim() === '') {
    return { ok: false, response: fail('INVALID_INPUT', 'Target selector must be a non-empty string') };
  }
  let element: Element | null;
  try {
    element = document.querySelector(spec.selector);
  } catch {
    return { ok: false, response: fail('INVALID_INPUT', 'Invalid CSS selector') };
  }
  if (!element) {
    return {
      ok: false,
      response: fail('ELEMENT_NOT_FOUND', `No element matches selector: ${spec.selector}`),
    };
  }
  return { ok: true, element };
}

function opPing(): PageOpResponse {
  return ok({ pong: true });
}

function opClick(payload: unknown): PageOpResponse {
  const resolved = resolveTarget((payload as { target?: unknown } | undefined)?.target);
  if (!resolved.ok) return resolved.response;
  const element = resolved.element;
  if (!(element instanceof HTMLElement)) {
    return fail('INVALID_INPUT', 'Matched element is not clickable');
  }
  element.click();
  return ok({ url: location.href, title: document.title });
}

function opType(payload: unknown): PageOpResponse {
  const p = payload as { target?: unknown; text?: unknown } | undefined;
  if (typeof p?.text !== 'string') {
    return fail('INVALID_INPUT', 'TYPE payload requires a string text field');
  }
  const resolved = resolveTarget(p.target);
  if (!resolved.ok) return resolved.response;
  const element = resolved.element;

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.value = p.text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    element.textContent = p.text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return fail('INVALID_INPUT', 'Matched element is not a text input');
  }
  return ok({ url: location.href, title: document.title, length: p.text.length });
}

function opScroll(payload: unknown): PageOpResponse {
  const p = payload as { direction?: unknown; amount?: unknown } | undefined;
  const directions: ScrollDirection[] = ['up', 'down', 'left', 'right'];
  if (typeof p?.direction !== 'string' || !directions.includes(p.direction as ScrollDirection)) {
    return fail('INVALID_INPUT', 'SCROLL direction must be up, down, left or right');
  }
  if (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount < 1) {
    return fail('INVALID_INPUT', 'SCROLL amount must be a positive number');
  }
  const dx = p.direction === 'left' ? -p.amount : p.direction === 'right' ? p.amount : 0;
  const dy = p.direction === 'up' ? -p.amount : p.direction === 'down' ? p.amount : 0;
  window.scrollBy(dx, dy);
  return ok({ scrollX: window.scrollX, scrollY: window.scrollY });
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

const ELEMENT_QUERY =
  'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [tabindex]';

function textOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const value = (el as HTMLInputElement).value;
    if (value.trim()) return value.trim();
  }
  const options = el instanceof HTMLSelectElement ? Array.from(el.selectedOptions).map((o) => o.textContent ?? '').join(' ') : '';
  const inner = el.textContent ?? '';
  return (options || inner).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function selectorOf(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    const escaped = id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    return `#${escaped}`;
  }
  const testid = el.getAttribute('data-testid');
  if (testid) {
    return `[data-testid="${testid.replace(/"/g, '\\"')}"]`;
  }
  return el.tagName.toLowerCase();
}

function collectElements(): ElementInfo[] {
  const found = Array.from(document.querySelectorAll(ELEMENT_QUERY)).filter(isVisible);
  return found
    .slice(0, MAX_PAGE_ELEMENTS)
    .map((el, index) => ({
      index,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: textOf(el),
    }));
}

function collectHeadings(): string[] {
  const found = Array.from(
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'),
  ).filter(isVisible);
  return found.slice(0, MAX_PAGE_HEADINGS).map((el) => {
    const level = el.getAttribute('aria-level') ?? el.tagName.slice(1);
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return `h${level}: ${text || '…'}`;
  });
}

function opGetPage(): PageOpResponse {
  const raw = document.body?.innerText ?? '';
  const truncated = raw.length > MAX_PAGE_TEXT_CHARS;
  return ok({
    url: location.href,
    title: document.title,
    text: truncated ? raw.slice(0, MAX_PAGE_TEXT_CHARS) : raw,
    truncated,
    headings: collectHeadings(),
    elements: collectElements(),
  });
}

const HANDLERS: Record<PageOpName, (payload: unknown) => PageOpResponse> = {
  PING: opPing,
  CLICK: opClick,
  TYPE: opType,
  SCROLL: opScroll,
  GET_PAGE: () => opGetPage(),
};

function handle(message: PageOpRequest): PageOpResponse {
  const handler = HANDLERS[message.op];
  if (!handler) {
    return fail('UNSUPPORTED_OPERATION', `Unknown page op: ${String(message.op)}`);
  }
  try {
    return handler(message.payload);
  } catch (error) {
    return fail('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'PAGE_OP') {
    return false;
  }
  const response = handle(message as PageOpRequest);
  sendResponse(response);
  return false;
});

console.log('AgentWebEinh: content script ready');
