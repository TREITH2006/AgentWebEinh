export const INTERACTION_COMMANDS = ['CLICK', 'TYPE', 'SCROLL', 'STOP'] as const;

export type InteractionCommand = (typeof INTERACTION_COMMANDS)[number];

export interface InteractionRequest {
  command: InteractionCommand;
  selector?: string;
  text?: string;
  deltaY?: number;
}

export function isInteractionRequest(value: unknown): value is InteractionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InteractionRequest>;
  if (typeof candidate.command !== 'string') return false;
  return (INTERACTION_COMMANDS as readonly string[]).includes(candidate.command);
}
