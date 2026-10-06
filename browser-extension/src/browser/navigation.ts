export const NAVIGATION_COMMANDS = ['OPEN_URL', 'BACK', 'NEW_TAB'] as const;

export type NavigationCommand = (typeof NAVIGATION_COMMANDS)[number];

export interface NavigationRequest {
  command: NavigationCommand;
  url?: string;
}

export function isNavigationRequest(value: unknown): value is NavigationRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NavigationRequest>;
  if (typeof candidate.command !== 'string') return false;
  return (NAVIGATION_COMMANDS as readonly string[]).includes(candidate.command);
}
