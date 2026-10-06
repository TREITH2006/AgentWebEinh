export const EXTENSION_NAME = 'AgentWebEinh';
export const EXTENSION_PHASE = 'Phase 2C';
export const EXTENSION_SUBTITLE = 'Paired Browser Engine';

export type ConnectionState = 'ready' | 'disconnected' | 'error';

export interface StatusPayload {
  name: string;
  phase: string;
  subtitle: string;
  status: string;
  connection: ConnectionState;
  timestamp: number;
  connected: boolean;
  paired?: boolean;
  browserId?: string | null;
  backendUrl?: string;
  pairing?: 'idle' | 'waiting' | 'paired' | 'rejected' | 'error';
  lastError?: string | null;
}
