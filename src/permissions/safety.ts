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
// Git write operations (when wildcarded)
const GIT_WRITE_SUBCOMMANDS = [
  'push', 'reset', 'clean', 'rebase', 'merge', 'stash',
];
// Git subcommands that are dangerous with wildcards
const GIT_WILDCARD_DANGEROUS = [
  'checkout', 'branch',
];

/**
 * Assess safety of permission patterns using blocklist + LLM
 */
export async function assessSafety(
  patterns: PermissionPattern[],
): Promise<Map<string, SafetyResult>> {
  const results = new Map<string, SafetyResult>();
  const needsLlm: PermissionPattern[] = [];

  for (const pattern of patterns) {
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
  }

  return null;
}

const SYSTEM_PROMPT = `You are a security reviewer for Claude Code permission patterns. You assess whether auto-allowing a tool pattern is safe.

A permission pattern like "Bash(git diff *)" means: automatically allow running any Bash command that starts with "git diff " without asking the user.
A pattern like "Edit" means: automatically allow all Edit tool uses.
A pattern like "Bash(ls)" means: allow only the exact command "ls".

Rules:
- Mark SAFE patterns that are read-only, non-destructive, and limited in scope
- Mark UNSAFE patterns that could delete data, modify system state, exfiltrate data, or escalate privileges
- Wildcard patterns need extra scrutiny: "git branch" (show current branch) is safe, "git branch *" (could delete branches) is dangerous
- When in doubt, mark UNSAFE
- Consider what the worst-case command matching the pattern could do

Respond with a JSON array of objects: [{"index": 1, "safe": true/false, "reason": "brief explanation"}]
Only output the JSON array, no other text.`;

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
