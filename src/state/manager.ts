/**
 * State persistence for tracking processed sessions
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { ReflectorState, ProcessedSessionRecord } from '../types/state.js';
import { DEFAULT_STATE } from '../types/state.js';

const PROJECT_DIR = join(import.meta.dirname, '..', '..');
const STATE_FILE = join(PROJECT_DIR, 'state.json');

export async function loadState(): Promise<ReflectorState> {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(content) as ReflectorState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_STATE, processedSessions: {} };
    }
    throw err;
  }
}

export async function saveState(state: ReflectorState): Promise<void> {
  const tempFile = `${STATE_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2), 'utf-8');
  await fs.rename(tempFile, STATE_FILE);
}

export function isSessionProcessed(
  state: ReflectorState,
  sessionId: string,
  modifiedAt: string,
): boolean {
  const record = state.processedSessions[sessionId];
  if (!record) return false;
  // Re-process if the session has been modified since we last processed it
  return record.modifiedAt === modifiedAt;
}

export function markSessionProcessed(
  state: ReflectorState,
  sessionId: string,
  modifiedAt: string,
  findingsCount: number,
): void {
  state.processedSessions[sessionId] = {
    sessionId,
    processedAt: new Date().toISOString(),
    modifiedAt,
    findingsCount,
  };
  state.lastRunAt = new Date().toISOString();
}
