export const BROWSER_ERROR_CODES = [
  'INVALID_COMMAND',
  'INVALID_INPUT',
  'INVALID_URL',
  'TAB_NOT_FOUND',
  'ELEMENT_NOT_FOUND',
  'PAGE_NOT_READY',
  'NAVIGATION_FAILURE',
  'CONTENT_SCRIPT_UNAVAILABLE',
  'PERMISSION_FAILURE',
  'SCREENSHOT_FAILURE',
  'UNSUPPORTED_OPERATION',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number];

export interface BrowserError {
  code: BrowserErrorCode;
  message: string;
}

export function isBrowserErrorCode(value: unknown): value is BrowserErrorCode {
  return typeof value === 'string' && (BROWSER_ERROR_CODES as readonly string[]).includes(value);
}

export function makeError(code: BrowserErrorCode, message: string): BrowserError {
  return { code, message };
}
