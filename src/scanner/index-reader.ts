/**
 * Reads sessions-index.json files from ~/.claude/projects/
 * and returns filtered session entries
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionIndex, SessionIndexEntry } from '../types/session.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export interface ScanOptions {
  excludedPaths: string[];
  minMessages: number;
  sessionId?: string;
}

/**
 * Find all sessions-index.json files and return filtered entries
 */
export async function readAllSessionEntries(options: ScanOptions): Promise<SessionIndexEntry[]> {
  const entries: SessionIndexEntry[] = [];

  let projectDirs: string[];
  try {
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    projectDirs = dirents
      .filter(d => d.isDirectory())
      .map(d => join(PROJECTS_DIR, d.name));
  } catch {
    return entries;
  }

  for (const projectDir of projectDirs) {
    const indexPath = join(projectDir, 'sessions-index.json');
    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      const index: SessionIndex = JSON.parse(content);

      for (const entry of index.entries) {
        if (shouldInclude(entry, options)) {
          entries.push(entry);
        }
      }
    } catch {
      // Index file doesn't exist or is malformed, skip
      continue;
    }
  }

  // Sort by modified date (newest first)
  entries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  return entries;
}

function shouldInclude(entry: SessionIndexEntry, options: ScanOptions): boolean {
  // Filter specific session
  if (options.sessionId && entry.sessionId !== options.sessionId) {
    return false;
  }

  // Skip sidechains
  if (entry.isSidechain) {
    return false;
  }

  // Skip sessions with too few messages
  if (entry.messageCount < options.minMessages) {
    return false;
  }

  // Skip excluded project paths
  const normalizedProjectPath = normalizePath(entry.projectPath);
  for (const excluded of options.excludedPaths) {
    if (normalizedProjectPath.startsWith(normalizePath(excluded))) {
      return false;
    }
  }

  return true;
}

function normalizePath(p: string): string {
  return p.replace(/^~/, homedir()).replace(/\/+$/, '');
}
