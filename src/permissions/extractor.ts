/**
 * Extracts tool use records from JSONL session files
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { SessionIndexEntry } from '../types/session.js';
import type { ToolUseRecord } from '../types/permissions.js';
import { extractResultContent, isUserRejection } from '../utils/jsonl.js';

// Only track tools that can be configured in settings.json permissions.allow
// Edit/Write use a separate "auto-edit" permission mode, not settings.json
const TRACKABLE_TOOLS: Record<string, string | null> = {
  Bash: 'command',
  WebFetch: null,
  WebSearch: null,
};

/**
 * Extract tool use records from a session JSONL file
 */
export async function extractToolUses(entry: SessionIndexEntry): Promise<ToolUseRecord[]> {
  const records: ToolUseRecord[] = [];

  // Track pending tool_use blocks: id → { toolName, keyParam }
  const pendingToolUses = new Map<string, { toolName: string; keyParam: string }>();

  const rl = createInterface({
    input: createReadStream(entry.fullPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    if (raw.isSidechain) continue;
    if (raw.type === 'summary' || raw.type === 'progress') continue;

    const message = raw.message as { role?: string; content?: unknown } | undefined;
    if (!message?.role || !message.content) continue;
    if (!Array.isArray(message.content)) continue;

    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue;

        const toolName = block.name as string;
        if (!(toolName in TRACKABLE_TOOLS)) continue;

        const keyParam = extractKeyParam(toolName, block.input);
        pendingToolUses.set(block.id as string, { toolName, keyParam });
      }
    }

    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;

        const toolUseId = block.tool_use_id as string;
        const pending = pendingToolUses.get(toolUseId);
        if (!pending) continue;

        pendingToolUses.delete(toolUseId);

        const resultText = extractResultContent(block.content);
        const rejected = isUserRejection(resultText);

        records.push({
          toolName: pending.toolName,
          keyParam: pending.keyParam,
          approved: !rejected,
          sessionId: entry.sessionId,
          projectPath: entry.projectPath,
        });
      }
    }
  }

  return records;
}

function extractKeyParam(toolName: string, input: unknown): string {
  const paramKey = TRACKABLE_TOOLS[toolName];
  if (!paramKey) return '';
  if (!input || typeof input !== 'object') return '';

  const value = (input as Record<string, unknown>)[paramKey];
  return typeof value === 'string' ? value : '';
}

