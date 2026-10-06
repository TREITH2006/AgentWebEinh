import { makeError, type BrowserError } from './errors';

export const BROWSER_COMMAND_NAMES = [
  'OPEN_URL',
  'CLICK',
  'TYPE',
  'SCROLL',
  'BACK',
  'NEW_TAB',
  'GET_PAGE',
  'SCREENSHOT',
  'STOP',
] as const;

export type BrowserCommandName = (typeof BROWSER_COMMAND_NAMES)[number];

export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

export const TARGET_STRATEGIES = ['css'] as const;
export type TargetStrategy = (typeof TARGET_STRATEGIES)[number];

export interface TargetSpec {
  strategy: TargetStrategy;
  selector: string;
}

export const MAX_SELECTOR_LENGTH = 1000;
export const MAX_TYPE_TEXT_LENGTH = 5000;
export const MAX_SCROLL_AMOUNT = 20000;

export type BrowserCommand =
  | { command: 'OPEN_URL'; url: string }
  | { command: 'CLICK'; target: TargetSpec }
  | { command: 'TYPE'; target: TargetSpec; text: string }
  | { command: 'SCROLL'; direction: ScrollDirection; amount: number }
  | { command: 'BACK' }
  | { command: 'NEW_TAB'; url?: string }
  | { command: 'GET_PAGE' }
  | { command: 'SCREENSHOT'; format: 'jpeg' | 'png' }
  | { command: 'STOP' };

export interface BrowserCommandEnvelope {
  type: 'BROWSER_COMMAND';
  requestId: string;
  command: unknown;
}

export type ParseResult =
  | { ok: true; command: BrowserCommand }
  | { ok: false; error: BrowserError };

export function isBrowserCommandEnvelope(value: unknown): value is BrowserCommandEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BrowserCommandEnvelope>;
  return (
    candidate.type === 'BROWSER_COMMAND' &&
    typeof candidate.requestId === 'string' &&
    'command' in candidate
  );
}

export function isBrowserCommandName(value: unknown): value is BrowserCommandName {
  return typeof value === 'string' && (BROWSER_COMMAND_NAMES as readonly string[]).includes(value);
}

function fail(error: BrowserError): ParseResult {
  return { ok: false, error };
}

function parseHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

type TargetParseResult = { ok: true; target: TargetSpec } | { ok: false; error: BrowserError };

function parseTarget(obj: Record<string, unknown>): TargetParseResult {

  const source = obj.target !== undefined ? obj.target : obj;

  if (typeof source !== 'object' || source === null) {
    return { ok: false, error: makeError('INVALID_INPUT', 'Target must be an object with a selector') };
  }
  const target = source as Record<string, unknown>;

  if (target.strategy !== undefined) {
    if (typeof target.strategy !== 'string' || !(TARGET_STRATEGIES as readonly string[]).includes(target.strategy)) {
      return {
        ok: false,
        error: makeError(
          'UNSUPPORTED_OPERATION',
          `Target strategy "${String(target.strategy)}" is not supported yet (supported: css)`,
        ),
      };
    }
  }

  if (typeof target.selector !== 'string' || target.selector.trim() === '') {
    return { ok: false, error: makeError('INVALID_INPUT', 'Target selector must be a non-empty string') };
  }
  if (target.selector.length > MAX_SELECTOR_LENGTH) {
    return {
      ok: false,
      error: makeError('INVALID_INPUT', `Target selector exceeds ${MAX_SELECTOR_LENGTH} characters`),
    };
  }
  return { ok: true, target: { strategy: 'css', selector: target.selector } };
}

export function parseBrowserCommand(value: unknown): ParseResult {
  if (typeof value !== 'object' || value === null) {
    return fail(makeError('INVALID_COMMAND', 'Command must be an object'));
  }
  const obj = value as Record<string, unknown>;
  const name = obj.command;

  if (typeof name !== 'string') {
    return fail(makeError('INVALID_COMMAND', 'Command is missing a "command" field'));
  }
  if (!isBrowserCommandName(name)) {
    return fail(makeError('INVALID_COMMAND', `Unknown command: ${name}`));
  }

  switch (name) {
    case 'OPEN_URL': {
      const url = parseHttpUrl(obj.url);
      if (url === null) {
        return fail(
          makeError('INVALID_URL', 'OPEN_URL requires an absolute http(s) URL'),
        );
      }
      return { ok: true, command: { command: 'OPEN_URL', url } };
    }

    case 'NEW_TAB': {
      if (obj.url === undefined || obj.url === null) {
        return { ok: true, command: { command: 'NEW_TAB' } };
      }
      const url = parseHttpUrl(obj.url);
      if (url === null) {
        return fail(makeError('INVALID_URL', 'NEW_TAB url must be an absolute http(s) URL'));
      }
      return { ok: true, command: { command: 'NEW_TAB', url } };
    }

    case 'CLICK': {
      const parsed = parseTarget(obj);
      if (!parsed.ok) return parsed;
      return { ok: true, command: { command: 'CLICK', target: parsed.target } };
    }

    case 'TYPE': {
      const parsed = parseTarget(obj);
      if (!parsed.ok) return parsed;
      if (typeof obj.text !== 'string') {
        return fail(makeError('INVALID_INPUT', 'TYPE requires a string "text" field'));
      }
      if (obj.text.length > MAX_TYPE_TEXT_LENGTH) {
        return fail(
          makeError('INVALID_INPUT', `TYPE text exceeds ${MAX_TYPE_TEXT_LENGTH} characters`),
        );
      }
      return { ok: true, command: { command: 'TYPE', target: parsed.target, text: obj.text } };
    }

    case 'SCROLL': {
      if (
        typeof obj.direction !== 'string' ||
        !(SCROLL_DIRECTIONS as readonly string[]).includes(obj.direction)
      ) {
        return fail(
          makeError('INVALID_INPUT', 'SCROLL direction must be one of: up, down, left, right'),
        );
      }
      if (
        typeof obj.amount !== 'number' ||
        !Number.isFinite(obj.amount) ||
        !Number.isInteger(obj.amount) ||
        obj.amount < 1 ||
        obj.amount > MAX_SCROLL_AMOUNT
      ) {
        return fail(
          makeError(
            'INVALID_INPUT',
            `SCROLL amount must be an integer between 1 and ${MAX_SCROLL_AMOUNT}`,
          ),
        );
      }
      return {
        ok: true,
        command: { command: 'SCROLL', direction: obj.direction as ScrollDirection, amount: obj.amount },
      };
    }

    case 'BACK':
      return { ok: true, command: { command: 'BACK' } };

    case 'GET_PAGE':
      return { ok: true, command: { command: 'GET_PAGE' } };

    case 'SCREENSHOT': {
      if (obj.format !== undefined && obj.format !== 'jpeg' && obj.format !== 'png') {
        return fail(makeError('INVALID_INPUT', 'SCREENSHOT format must be "jpeg" or "png"'));
      }
      return {
        ok: true,
        command: { command: 'SCREENSHOT', format: (obj.format as 'jpeg' | 'png' | undefined) ?? 'jpeg' },
      };
    }

    case 'STOP':
      return { ok: true, command: { command: 'STOP' } };

    default:
      return fail(makeError('INVALID_COMMAND', `Unknown command: ${name}`));
  }
}
