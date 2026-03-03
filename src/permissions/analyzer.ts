/**
 * Normalizes tool uses into permission patterns and aggregates them
 */

import type { ToolUseRecord, PermissionPattern, PermissionSuggestion } from '../types/permissions.js';
import { isToolAllowed } from './settings-reader.js';

// Commands where we keep first 2 words as the base
const MULTI_WORD_COMMANDS = new Set([
  'git', 'yarn', 'npm', 'npx', 'pnpm', 'docker', 'kubectl',
  'gh', 'gcloud', 'brew', 'claude',
]);

export interface AnalysisResult {
  patterns: PermissionPattern[];
  alreadyCovered: number;
}

/**
 * Normalize tool uses into patterns, filter already-allowed ones, and aggregate
 */
export function analyzeToolUses(records: ToolUseRecord[], allowList: string[]): AnalysisResult {
  let alreadyCovered = 0;
  const patternMap = new Map<string, PermissionPattern>();

  for (const record of records) {
    // Check if already allowed
    if (isToolAllowed(record.toolName, record.keyParam, allowList)) {
      alreadyCovered++;
      continue;
    }

    const pattern = normalizeToPattern(record.toolName, record.keyParam);
    if (!pattern || isNoisePattern(pattern)) continue;

    const existing = patternMap.get(pattern);
    if (existing) {
      if (record.approved) existing.approvalCount++;
      else existing.rejectionCount++;
      if (!existing.sessionIds.includes(record.sessionId)) {
        existing.sessionIds.push(record.sessionId);
      }
      if (!existing.projectPaths.includes(record.projectPath)) {
        existing.projectPaths.push(record.projectPath);
      }
    } else {
      patternMap.set(pattern, {
        pattern,
        approvalCount: record.approved ? 1 : 0,
        rejectionCount: record.approved ? 0 : 1,
        sessionIds: [record.sessionId],
        projectPaths: [record.projectPath],
      });
    }
  }

  // Merge exact+wildcard duplicates: Bash(X) + Bash(X *) → Bash(X *)
  for (const [key, pattern] of patternMap) {
    const prefix = parseBashWildcard(key);
    if (!prefix) continue;
    const exactKey = `Bash(${prefix})`;
    const exactPattern = patternMap.get(exactKey);
    if (!exactPattern) continue;

    pattern.approvalCount += exactPattern.approvalCount;
    pattern.rejectionCount += exactPattern.rejectionCount;
    for (const sid of exactPattern.sessionIds) {
      if (!pattern.sessionIds.includes(sid)) pattern.sessionIds.push(sid);
    }
    for (const pp of exactPattern.projectPaths) {
      if (!pattern.projectPaths.includes(pp)) pattern.projectPaths.push(pp);
    }
    patternMap.delete(exactKey);
  }

  // Sort by approval count descending, filter low-signal patterns
  const MIN_APPROVALS = 3;
  const patterns = Array.from(patternMap.values())
    .filter(p => p.approvalCount >= MIN_APPROVALS)
    .sort((a, b) => b.approvalCount - a.approvalCount);

  return { patterns, alreadyCovered };
}

/**
 * Determine whether a pattern should be global or project-scoped
 */
export function determineScope(pattern: PermissionPattern): { scope: 'global' | 'project'; scopeDetail?: string } {
  if (pattern.projectPaths.length >= 2) {
    return { scope: 'global' };
  }
  return { scope: 'project', scopeDetail: pattern.projectPaths[0] };
}

/**
 * Normalize a tool use into a permission pattern string
 */
function normalizeToPattern(toolName: string, keyParam: string): string {
  if (toolName !== 'Bash') {
    // Non-Bash tools: just the tool name (e.g., "Edit", "WebFetch")
    return toolName;
  }

  if (!keyParam) return 'Bash';

  const command = stripEnvPrefix(keyParam).trim();
  if (!command) return 'Bash';

  const base = extractCommandBase(command);
  const hasArgs = command.length > base.length;

  return hasArgs ? `Bash(${base} *)` : `Bash(${base})`;
}

/**
 * Extract command base: for multi-word commands like "git diff", use first 2 words.
 * For others, use first word. Also handles "git -C <path>" prefix.
 */
function extractCommandBase(command: string): string {
  const words = command.split(/\s+/);
  if (words.length === 0) return command;

  const first = words[0];

  if (first === 'git' && words.length >= 2) {
    // Handle "git -C <path> <subcommand>" → "git <subcommand>"
    if (words[1] === '-C' && words.length >= 4) {
      return `git ${words[3]}`;
    }
    return `git ${words[1]}`;
  }

  if (MULTI_WORD_COMMANDS.has(first) && words.length >= 2) {
    return `${first} ${words[1]}`;
  }

  return first;
}

/**
 * Strip environment variable prefixes like "NODE_ENV=test yarn test"
 */
function stripEnvPrefix(command: string): string {
  return command.replace(/^(\w+=\S+\s+)+/, '');
}

// Patterns that are noise and shouldn't be suggested
const NOISE_BASES = new Set(['#', 'for', 'if', 'while', 'case', 'cd', 'echo', 'version']);

/**
 * Filter out noise patterns: comments, shell constructs, and overly specific file paths
 */
function isNoisePattern(pattern: string): boolean {
  const match = pattern.match(/^Bash\((\S+)/);
  if (!match) return false;

  const base = match[1];
  if (NOISE_BASES.has(base)) return true;

  // Filter out patterns that are full file paths (likely one-off scripts)
  if (base.includes('/') && !base.startsWith('./') && !base.startsWith('~/')) return true;

  return false;
}

/**
 * Extract the command prefix from a wildcard pattern like "Bash(git fetch *)".
 * Returns the prefix (e.g., "git fetch") or null if not a wildcard pattern.
 */
export function parseBashWildcard(pattern: string): string | null {
  const match = pattern.match(/^Bash\((.+) \*\)$/);
  return match ? match[1] : null;
}

/**
 * Find an existing allow pattern that is a narrower version of the suggested pattern.
 * E.g., suggested "Bash(git fetch *)" partially overlaps existing "Bash(git fetch origin)".
 */
export function findPartialOverlap(suggested: string, allowList: string[]): string | null {
  const prefix = parseBashWildcard(suggested);
  if (!prefix) return null;

  for (const existing of allowList) {
    const existingMatch = existing.match(/^Bash\((.+)\)$/);
    if (!existingMatch) continue;
    const existingCmd = existingMatch[1];
    if (existingCmd.startsWith(prefix) && !existingCmd.endsWith('*') && existingCmd !== prefix) {
      return existing;
    }
  }
  return null;
}

// Patterns where the wildcard form includes dangerous subcommands
const WILDCARD_CAVEATS: Record<string, string> = {
  'Bash(gh pr *)': 'includes merge/close — review with care',
  'Bash(gh issue *)': 'includes close/delete — review with care',
};

/**
 * Add notes to suggestions for partial overlaps and known caveats.
 */
export function annotateSuggestions(suggestions: PermissionSuggestion[], allowList: string[]): void {
  for (const s of suggestions) {
    const notes: string[] = [];

    const caveat = WILDCARD_CAVEATS[s.pattern];
    if (caveat) notes.push(caveat);

    const overlap = findPartialOverlap(s.pattern, allowList);
    if (overlap) notes.push(`broadens existing \`${overlap}\``);

    if (notes.length > 0) s.notes = notes;
  }
}
