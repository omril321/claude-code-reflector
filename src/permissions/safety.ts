/**
 * Safety assessment for permission patterns: blocklist + LLM verification
 */

import type { PermissionPattern } from '../types/permissions.js';
import { callModel } from '../analyzer/anthropic-client.js';

export interface SafetyResult {
  safe: boolean;
  reason: string;
}

// Destructive commands
const DESTRUCTIVE = ['rm', 'rmdir', 'shred', 'unlink'];
// Permission-altering commands
const PERMISSION_CMDS = ['chmod', 'chown', 'chgrp'];
// System-level commands
const SYSTEM_CMDS = ['sudo', 'su', 'kill', 'pkill', 'killall'];
// File-modifying commands that are dangerous with wildcards
const FILE_MODIFY_CMDS = ['cp', 'mv', 'sed'];
// Shell execution commands
const SHELL_EXEC_CMDS = ['source', 'bash', 'sh', 'eval', 'exec', 'tmux'];
// System state modifiers
const SYSTEM_STATE_CMDS = ['defaults', 'export'];
// Git write operations (when wildcarded)
const GIT_WRITE_SUBCOMMANDS = [
  'push', 'reset', 'clean', 'rebase', 'merge', 'stash',
];
// Git subcommands that are dangerous with wildcards
const GIT_WILDCARD_DANGEROUS = [
  'checkout', 'branch',
];

// gh subcommands that include destructive operations (create/delete/close)
const GH_DANGEROUS_SUBCOMMANDS = ['repo', 'release', 'api'];

// Package manager commands that install arbitrary packages
const PACKAGE_INSTALL_CMDS = new Set(['install', 'add', 'i']);

// Safe read-only git subcommands (skip LLM, auto-approve)
const GIT_SAFE_SUBCOMMANDS = [
  'status', 'diff', 'log', 'show', 'fetch', 'ls-files', 'ls-tree',
  'rev-parse', 'remote', 'check-ignore', 'describe', 'tag',
  'shortlog', 'blame', 'config',
];

// Package manager script commands are safe (defined in project package.json)
const SAFE_PACKAGE_SCRIPTS = new Set([
  'build', 'lint', 'test', 'test:unit', 'test:run', 'test:e2e',
  'tsc', 'typecheck', 'type-check', 'check', 'fmt', 'fmt.check',
  'format', 'dev', 'start', 'preview', 'clean', 'prepare',
  'tsx', 'generate', 'codegen', 'cf-typegen', 'why',
  'build:widgets', 'lint:fix',
]);

// Package manager bases
const PACKAGE_MANAGERS = new Set(['yarn', 'npm', 'npx', 'pnpm']);

// Read-only commands that are always safe
const ALWAYS_SAFE = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'which',
  'file', 'stat', 'du', 'df', 'readlink', 'basename', 'dirname',
  'test', 'true', 'false', 'pwd', 'whoami', 'hostname', 'date',
  'uname', 'arch', 'mdfind', 'mdls', 'lsof', 'xxd', 'hexdump',
  'sleep', 'printf', 'git', // bare git = git status
]);

/**
 * Assess safety of permission patterns using blocklist + LLM
 */
export async function assessSafety(
  patterns: PermissionPattern[],
): Promise<Map<string, SafetyResult>> {
  const results = new Map<string, SafetyResult>();
  const needsLlm: PermissionPattern[] = [];

  for (const pattern of patterns) {
    const safeResult = checkSafelist(pattern.pattern);
    if (safeResult) {
      results.set(pattern.pattern, safeResult);
      continue;
    }
    const blocklistResult = checkBlocklist(pattern.pattern);
    if (blocklistResult) {
      results.set(pattern.pattern, blocklistResult);
    } else {
      needsLlm.push(pattern);
    }
  }

  if (needsLlm.length > 0) {
    const llmResults = await batchLlmAssessment(needsLlm);
    for (const [pattern, result] of llmResults) {
      results.set(pattern, result);
    }
  }

  return results;
}

/**
 * Auto-approve known safe patterns (read-only commands, package manager scripts)
 */
function checkSafelist(pattern: string): SafetyResult | null {
  const match = pattern.match(/^Bash\((.+?)\s*(?:\*)?\)$/);
  if (!match) return null;

  const command = match[1].trim();
  const parts = command.split(/\s+/);
  const baseCmd = parts[0];
  const isWildcard = pattern.includes(' *)');
  const isExact = !isWildcard;

  // Read-only commands (with or without wildcards)
  if (ALWAYS_SAFE.has(baseCmd) && parts.length === 1) {
    return { safe: true, reason: `${baseCmd} is a read-only command` };
  }

  // Package manager + known script name
  if (PACKAGE_MANAGERS.has(baseCmd) && parts.length >= 2) {
    const script = parts[1];
    if (SAFE_PACKAGE_SCRIPTS.has(script)) {
      return { safe: true, reason: `${baseCmd} ${script} runs a standard project script` };
    }
  }

  // Safe git subcommands
  if (baseCmd === 'git' && parts.length >= 2) {
    const subcommand = parts[1];
    if (GIT_SAFE_SUBCOMMANDS.includes(subcommand)) {
      return { safe: true, reason: `git ${subcommand} is a read-only operation` };
    }
    // git add is staging-only, reversible
    if (subcommand === 'add') {
      return { safe: true, reason: 'git add stages files, reversible with git reset' };
    }
  }

  // mkdir is safe (creating directories is non-destructive)
  if (baseCmd === 'mkdir') {
    return { safe: true, reason: 'mkdir creates directories, non-destructive' };
  }

  return null;
}

function checkBlocklist(pattern: string): SafetyResult | null {
  // Check for output redirection
  if (pattern.includes('>') || pattern.includes('>>')) {
    return { safe: false, reason: 'contains output redirection' };
  }

  // Extract the command from Bash(...) patterns
  const match = pattern.match(/^Bash\((.+?)\s*(?:\*)?\)$/);
  if (!match) return null;

  const command = match[1].trim();
  const parts = command.split(/\s+/);
  const baseCmd = parts[0];
  const isWildcard = pattern.includes(' *)');

  // Destructive commands
  if (DESTRUCTIVE.includes(baseCmd)) {
    return { safe: false, reason: 'destructive file operation' };
  }

  // Permission commands
  if (PERMISSION_CMDS.includes(baseCmd)) {
    return { safe: false, reason: 'changes file permissions' };
  }

  // System commands
  if (SYSTEM_CMDS.includes(baseCmd)) {
    return { safe: false, reason: 'system-level operation' };
  }

  // Git write operations
  if (baseCmd === 'git' && parts.length >= 2) {
    const subcommand = parts[1];

    if (GIT_WRITE_SUBCOMMANDS.includes(subcommand)) {
      return { safe: false, reason: `git ${subcommand} modifies repository state` };
    }

    // Dangerous with wildcards
    if (isWildcard && GIT_WILDCARD_DANGEROUS.includes(subcommand)) {
      return { safe: false, reason: `git ${subcommand} with wildcards can be destructive` };
    }

    // git commit * can pass --amend, --no-verify
    if (subcommand === 'commit' && isWildcard) {
      return { safe: false, reason: 'git commit * could pass --amend or --no-verify flags' };
    }
  }

  // gh subcommands with destructive operations
  if (baseCmd === 'gh' && parts.length >= 2 && isWildcard) {
    const subcommand = parts[1];
    if (GH_DANGEROUS_SUBCOMMANDS.includes(subcommand)) {
      return { safe: false, reason: `gh ${subcommand} * includes destructive operations (delete, etc.)` };
    }
  }

  // Package manager install/add with wildcards
  if (PACKAGE_MANAGERS.has(baseCmd) && parts.length >= 2 && isWildcard) {
    const script = parts[1];
    if (PACKAGE_INSTALL_CMDS.has(script)) {
      return { safe: false, reason: `${baseCmd} ${script} * can install arbitrary packages` };
    }
  }

  // File-modifying commands with wildcards
  if (isWildcard && FILE_MODIFY_CMDS.includes(baseCmd)) {
    return { safe: false, reason: `${baseCmd} with wildcards can overwrite files` };
  }

  // Shell execution commands
  if (SHELL_EXEC_CMDS.includes(baseCmd)) {
    return { safe: false, reason: `${baseCmd} executes arbitrary code` };
  }

  // System state modifiers
  if (SYSTEM_STATE_CMDS.includes(baseCmd)) {
    return { safe: false, reason: `${baseCmd} modifies system state` };
  }

  return null;
}

const SYSTEM_PROMPT = `You are a security reviewer for Claude Code permission patterns. These patterns auto-allow tool usage in a developer's local CLI environment.

A pattern like "Bash(git diff *)" means: auto-allow any Bash command starting with "git diff ".
A pattern like "Bash(ls)" means: allow only the exact command "ls".

Context:
- These run in a LOCAL development environment on the developer's own machine
- The developer has already used and approved these commands multiple times
- This is about convenience, not production security

Guidelines:
- SAFE: Read-only commands, standard dev tooling, local build/test/lint commands
- UNSAFE: Commands that delete data, modify remote state, install arbitrary packages, or execute arbitrary code
- Wildcard patterns need scrutiny: "git branch" (show current) is safe, "git branch *" (could delete branches) is dangerous
- "yarn <script>" and "npm run <script>" run project-defined scripts from package.json — generally safe for known scripts
- "gh pr *", "gh issue *" are read-heavy GitHub CLI subcommands — generally safe. But "gh *" is too broad.
- When genuinely uncertain, mark UNSAFE

Respond with ONLY a JSON array: [{"index": 1, "safe": true/false, "reason": "brief explanation"}]`;

const BATCH_SIZE = 30;

async function batchLlmAssessment(
  patterns: PermissionPattern[],
): Promise<Map<string, SafetyResult>> {
  const results = new Map<string, SafetyResult>();

  // Process in chunks to avoid output truncation
  for (let start = 0; start < patterns.length; start += BATCH_SIZE) {
    const chunk = patterns.slice(start, start + BATCH_SIZE);
    const chunkResults = await assessChunk(chunk);
    for (const [pattern, result] of chunkResults) {
      results.set(pattern, result);
    }
  }

  return results;
}

async function assessChunk(
  patterns: PermissionPattern[],
): Promise<Map<string, SafetyResult>> {
  const results = new Map<string, SafetyResult>();

  const patternList = patterns
    .map((p, i) => `${i + 1}. ${p.pattern} (used ${p.approvalCount} times)`)
    .join('\n');

  const user = `Assess the safety of these permission patterns:\n\n${patternList}`;

  try {
    const response = await callModel(SYSTEM_PROMPT, user, { model: 'haiku', maxTokens: patterns.length * 80 });

    // Strip markdown code fences if present
    const jsonText = response.text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(jsonText) as Array<{ index: number; safe: boolean; reason: string }>;

    for (const item of parsed) {
      const pattern = patterns[item.index - 1];
      if (pattern) {
        results.set(pattern.pattern, { safe: item.safe, reason: item.reason });
      }
    }
  } catch (err) {
    console.error(`LLM safety assessment failed for batch: ${(err as Error).message}`);
    // Fail closed
    for (const pattern of patterns) {
      results.set(pattern.pattern, { safe: false, reason: 'LLM assessment failed — marking unsafe' });
    }
  }

  // Fill in any patterns not returned by LLM — fail closed
  for (const pattern of patterns) {
    if (!results.has(pattern.pattern)) {
      results.set(pattern.pattern, { safe: false, reason: 'not assessed by LLM' });
    }
  }

  return results;
}
