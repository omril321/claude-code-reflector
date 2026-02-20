/**
 * Types for processing state persistence
 */

export interface ProcessedSessionRecord {
  sessionId: string;
  processedAt: string;
  modifiedAt: string;
  findingsCount: number;
}

export interface ReflectorState {
  lastRunAt: string | null;
  processedSessions: Record<string, ProcessedSessionRecord>;
}

export const DEFAULT_STATE: ReflectorState = {
  lastRunAt: null,
  processedSessions: {},
};
