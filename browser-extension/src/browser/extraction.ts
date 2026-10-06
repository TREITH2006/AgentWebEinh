export const EXTRACTION_COMMANDS = ['GET_PAGE', 'SCREENSHOT'] as const;

export type ExtractionCommand = (typeof EXTRACTION_COMMANDS)[number];

export interface ExtractionRequest {
  command: ExtractionCommand;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
}

export function isExtractionRequest(value: unknown): value is ExtractionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExtractionRequest>;
  if (typeof candidate.command !== 'string') return false;
  return (EXTRACTION_COMMANDS as readonly string[]).includes(candidate.command);
}
