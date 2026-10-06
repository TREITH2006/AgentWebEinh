import type { StatusPayload } from '../types';

export const EVENT = {
  STATUS_CHANGED: 'STATUS_CHANGED',
  CONNECTION_CHANGED: 'CONNECTION_CHANGED',
} as const;

export const EVENTS = EVENT;

export type EventName = (typeof EVENT)[keyof typeof EVENT];

export interface ConnectionStatePayload {
  connected: boolean;
  pairing: 'idle' | 'waiting' | 'paired' | 'rejected' | 'error';
  browserId: string | null;
  connectionId: string | null;
  backendUrl: string;
  lastError: string | null;
}

export interface StatusChangedEvent {
  type: typeof EVENT.STATUS_CHANGED;
  status: StatusPayload;
}

export interface ConnectionChangedEvent {
  type: typeof EVENT.CONNECTION_CHANGED;
  status: ConnectionStatePayload;
}

export function createStatusChanged(status: StatusPayload): StatusChangedEvent {
  return { type: EVENT.STATUS_CHANGED, status };
}

export function createConnectionChanged(status: ConnectionStatePayload): ConnectionChangedEvent {
  return { type: EVENT.CONNECTION_CHANGED, status };
}

export function isConnectionChangedEvent(value: unknown): value is ConnectionChangedEvent {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === EVENT.CONNECTION_CHANGED;
}
