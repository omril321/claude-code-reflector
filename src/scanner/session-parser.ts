/**
 * Stream-parses JSONL session files and extracts condensed conversation text
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { RawJSONLEntry, CondensedSession, SessionIndexEntry } from '../types/session.js';

const MAX_ASSISTANT_CHARS = 2000;
const MAX_TOTAL_CHARS = 500_000;
const FULL_MAX_TOTAL_CHARS = 800_000;
const FULL_WINDOW_SIZE = 50;

export interface ParseOptions {
  full?: boolean;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Parse a JSONL session file into a condensed session for analysis
 */
export async function parseSession(
  entry: SessionIndexEntry,
  options?: ParseOptions,
): Promise<CondensedSession> {
  const full = options?.full ?? false;
  const messages: ParsedMessage[] = [];
  const skillsUsed: Set<string> = new Set();

  const fileStream = createReadStream(entry.fullPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const raw: RawJSONLEntry = JSON.parse(line);

      // Skip non-message entries
      if (raw.isSidechain) continue;
      if (raw.type === 'summary' || raw.type === 'progress') continue;

      if (!raw.message?.role || !raw.message?.content) continue;
      const { role, content } = raw.message;
      if (role !== 'user' && role !== 'assistant') continue;

      // Extract skill tool_use from assistant messages
      if (role === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
            skillsUsed.add(block.input.skill as string);
          }
        }
      }

      const text = extractText(content, role, full);
      if (!text) continue;

      messages.push({ role: role as 'user' | 'assistant', text });
    } catch {
      continue;
    }
  }

  const conversationText = buildConversationText(messages, full);

  return {
    sessionId: entry.sessionId,
    projectPath: entry.projectPath,
    summary: entry.summary,
    messageCount: entry.messageCount,
    created: entry.created,
    modified: entry.modified,
    conversationText,
    skillsUsed: Array.from(skillsUsed),
  };
}

function extractText(content: unknown, role: string, full: boolean): string {
  if (typeof content === 'string') {
    return role === 'assistant' && !full ? truncate(content, MAX_ASSISTANT_CHARS) : content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block.type === 'text' && block.text) {
        parts.push(block.text as string);
      }
      // Skip thinking, tool_result, tool_use (except Skill which we handle above)
    }
    const joined = parts.join('\n');
    return role === 'assistant' && !full ? truncate(joined, MAX_ASSISTANT_CHARS) : joined;
  }

  return '';
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

function buildConversationText(messages: ParsedMessage[], full: boolean): string {
  let parts: string[] = [];

  for (const msg of messages) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${label}: ${msg.text}`);
  }

  let text = parts.join('\n');

  const maxChars = full ? FULL_MAX_TOTAL_CHARS : MAX_TOTAL_CHARS;
  const windowSize = full ? FULL_WINDOW_SIZE : 20;

  if (text.length > maxChars) {
    const userIndices = messages
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter(i => i !== -1);

    if (userIndices.length > windowSize * 2) {
      const keepIndices = new Set<number>();
      const firstN = userIndices.slice(0, windowSize);
      const lastN = userIndices.slice(-windowSize);

      for (const idx of [...firstN, ...lastN]) {
        keepIndices.add(idx);
        if (idx > 0 && messages[idx - 1].role === 'assistant') {
          keepIndices.add(idx - 1);
        }
      }

      parts = [];
      for (let i = 0; i < messages.length; i++) {
        if (keepIndices.has(i)) {
          const label = messages[i].role === 'user' ? 'User' : 'Assistant';
          parts.push(`${label}: ${messages[i].text}`);
        }
      }

      const firstLastNIdx = lastN[0];
      const insertPos = parts.findIndex((_, i) => {
        const originalIdx = Array.from(keepIndices).sort((a, b) => a - b)[i];
        return originalIdx >= firstLastNIdx;
      });
      if (insertPos > 0) {
        parts.splice(insertPos, 0, '\n[... middle of conversation truncated ...]\n');
      }

      text = parts.join('\n');
    }
  }

  return text;
}
