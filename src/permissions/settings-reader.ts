/**
 * Reads ~/.claude/settings.json and matches tool uses against allow patterns
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

/**
 * Load the current allow list from ~/.claude/settings.json
 */
export async function loadAllowList(): Promise<string[]> {
  try {
    const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings: ClaudeSettings = JSON.parse(content);
    return settings.permissions?.allow ?? [];
  } catch {
    return [];
  }
}

/**
 * Check if a tool use matches any pattern in the allow list.
 *
 * Pattern formats:
 * - `ToolName` → matches any use of that tool
 * - `ToolName(exact)` → matches only when keyParam equals "exact"
 * - `ToolName(prefix *)` → matches when keyParam starts with "prefix "
 * - `ToolName(a * b *)` → glob matching with * as wildcard segments
 */
export function isToolAllowed(toolName: string, keyParam: string, allowList: string[]): boolean {
  for (const pattern of allowList) {
    if (matchPattern(toolName, keyParam, pattern)) return true;
  }
  return false;
}

function matchPattern(toolName: string, keyParam: string, pattern: string): boolean {
  // Parse pattern: "ToolName" or "ToolName(args)"
  const parenIdx = pattern.indexOf('(');
  if (parenIdx === -1) {
    // Bare tool name: matches any use
    return pattern === toolName;
  }

  const patternTool = pattern.slice(0, parenIdx);
  if (patternTool !== toolName) return false;

  // Extract args between parens
  if (!pattern.endsWith(')')) return false;
  const patternArgs = pattern.slice(parenIdx + 1, -1);

  if (!patternArgs.includes('*')) {
    // Exact match
    return keyParam === patternArgs;
  }

  // Glob match: split on * and check sequential containment
  return globMatch(keyParam, patternArgs);
}

function globMatch(value: string, pattern: string): boolean {
  const parts = pattern.split('*');
  let pos = 0;

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    if (i === 0) {
      // First segment must match at start
      if (!value.startsWith(segment)) return false;
      pos = segment.length;
    } else if (i === parts.length - 1) {
      // Last segment must match at end (if non-empty)
      if (segment && !value.slice(pos).endsWith(segment)) return false;
    } else {
      const idx = value.indexOf(segment, pos);
      if (idx === -1) return false;
      pos = idx + segment.length;
    }
  }

  return true;
}
