import type { BrowserErrorCode, BrowserError } from '../protocol/errors';
import { makeError } from '../protocol/errors';

export interface CancelToken {
  cancelled: boolean;
}

export class BrowserCommandError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserCommandError';
  }

  toBrowserError(): BrowserError {
    return makeError(this.code, this.message);
  }
}

export function throwIfCancelled(token: CancelToken): void {
  if (token.cancelled) {
    throw new BrowserCommandError('CANCELLED', 'Operation cancelled by STOP');
  }
}

export function toBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserCommandError) {
    return error.toBrowserError();
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as BrowserError).code === 'string' &&
    typeof (error as BrowserError).message === 'string'
  ) {
    return error as BrowserError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return makeError('INTERNAL_ERROR', message);
}
