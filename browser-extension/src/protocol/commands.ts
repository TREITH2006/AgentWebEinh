export const COMMAND = {
  PING: 'PING',
  GET_STATUS: 'GET_STATUS',
  SET_BACKEND_URL: 'SET_BACKEND_URL',
  PAIR: 'PAIR',
  UNPAIR: 'UNPAIR',
} as const;

export type CommandName = (typeof COMMAND)[keyof typeof COMMAND];

export interface CommandMessage {
  type: CommandName;
  requestId: string;
  payload?: unknown;
}

export interface CommandResult {
  requestId: string;
  ok: boolean;
  type: CommandName;
  payload?: unknown;
  error?: string;
}

const COMMAND_NAMES = Object.values(COMMAND) as readonly string[];

export function isCommandMessage(value: unknown): value is CommandMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CommandMessage>;
  return (
    typeof candidate.type === 'string' &&
    (COMMAND_NAMES as readonly string[]).includes(candidate.type) &&
    typeof candidate.requestId === 'string'
  );
}
