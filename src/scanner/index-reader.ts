/**
 * Reads sessions-index.json files from ~/.claude/projects/
 * and returns filtered session entries
 */

import { createReadStream, promises as fs } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
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
        if (!shouldInclude(entry, options)) continue;
        try {
          await fs.access(entry.fullPath);
          entries.push(entry);
        } catch {
          // JSONL file deleted — skip phantom entry
        }
      }

      // Supplement: discover JSONL files not listed in the index
      const indexedIds = new Set(index.entries.map(e => e.sessionId));
      const extraEntries = await discoverSessionsFromJsonl(projectDir, indexedIds);
      for (const entry of extraEntries) {
        if (shouldInclude(entry, options)) {
          entries.push(entry);
        }
      }
    } catch {
      const fallbackEntries = await discoverSessionsFromJsonl(projectDir);
      for (const entry of fallbackEntries) {
        if (shouldInclude(entry, options)) {
          entries.push(entry);
        }
      }
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

/**
 * Find a single session entry by ID across all projects (no filtering)
 */
export async function findSessionEntry(sessionId: string): Promise<SessionIndexEntry | null> {
  let projectDirs: string[];
  try {
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    projectDirs = dirents
      .filter(d => d.isDirectory())
      .map(d => join(PROJECTS_DIR, d.name));
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const indexPath = join(projectDir, 'sessions-index.json');
    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      const index: SessionIndex = JSON.parse(content);
      const entry = index.entries.find(e => e.sessionId === sessionId);
      if (entry) return entry;

      // Index exists but doesn't list this session — try JSONL directly
      const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
      try {
        const extracted = await extractSessionMetadata(jsonlPath);
        if (extracted) return extracted;
      } catch { /* file doesn't exist */ }
    } catch {
      const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
      try {
        const entry = await extractSessionMetadata(jsonlPath);
        if (entry) return entry;
      } catch { /* file doesn't exist */ }
      continue;
    }
  }

  return null;
}

function normalizePath(p: string): string {
  return p.replace(/^~/, homedir()).replace(/\/+$/, '');
}

/**
 * Discover sessions by scanning JSONL files directly (fallback when sessions-index.json is missing)
 */
async function discoverSessionsFromJsonl(
  projectDir: string,
  skipSessionIds?: Set<string>,
): Promise<SessionIndexEntry[]> {
  let files: string[];
  try {
    const dirents = await fs.readdir(projectDir);
    files = dirents.filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const entries: SessionIndexEntry[] = [];
  for (const file of files) {
    if (skipSessionIds?.has(basename(file, '.jsonl'))) continue;
    try {
      const entry = await extractSessionMetadata(join(projectDir, file));
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Extract session metadata from a single JSONL file by streaming through its entries
 */
async function extractSessionMetadata(filePath: string): Promise<SessionIndexEntry | null> {
  const stat = await fs.stat(filePath);
  const sessionId = basename(filePath, '.jsonl');

  let projectPath: string | null = null;
  let gitBranch = '';
  let isSidechain = false;
  let messageCount = 0;
  let firstPrompt = '';
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let metadataFound = false;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const raw = JSON.parse(line);

      if (raw.timestamp) {
        if (!firstTimestamp) firstTimestamp = raw.timestamp;
        lastTimestamp = raw.timestamp;
      }

      if (!metadataFound && raw.cwd) {
        projectPath = raw.cwd;
        if (raw.gitBranch) gitBranch = raw.gitBranch;
        if (raw.isSidechain) isSidechain = true;
        metadataFound = true;
      }

      if (raw.message?.role === 'user' || raw.message?.role === 'assistant') {
        messageCount++;
        if (!firstPrompt && raw.message.role === 'user') {
          firstPrompt = extractFirstPromptText(raw.message.content);
        }
      }
    } catch {
      continue;
    }
  }

  if (!projectPath) return null;

  return {
    sessionId,
    fullPath: filePath,
    fileMtime: stat.mtimeMs,
    firstPrompt,
    summary: '',
    messageCount,
    created: firstTimestamp ?? stat.birthtime.toISOString(),
    modified: lastTimestamp ?? stat.mtime.toISOString(),
    gitBranch,
    projectPath,
    isSidechain,
  };
}

function extractFirstPromptText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        text = block;
        break;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        text = block.text;
        break;
      }
    }
  }
  return text.length > 200 ? text.slice(0, 200) + '...' : text;
}
