/**
 * Stream-parses JSONL session files and extracts condensed conversation text
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { RawJSONLEntry, CondensedSession, SessionIndexEntry } from '../types/session.js';

const MAX_ASSISTANT_CHARS = 200;
const MAX_TOTAL_CHARS = 150_000;

interface ParsedMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Parse a JSONL session file into a condensed session for analysis
 */
export async function parseSession(entry: SessionIndexEntry): Promise<CondensedSession> {
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

      const text = extractText(content, role);
      if (!text) continue;

      messages.push({ role: role as 'user' | 'assistant', text });
    } catch {
      continue;
    }
  }

  const conversationText = buildConversationText(messages);

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

function extractText(content: unknown, role: string): string {
  if (typeof content === 'string') {
    return role === 'assistant' ? truncate(content, MAX_ASSISTANT_CHARS) : content;
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
    return role === 'assistant' ? truncate(joined, MAX_ASSISTANT_CHARS) : joined;
  }

  return '';
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

function buildConversationText(messages: ParsedMessage[]): string {
  let parts: string[] = [];

  for (const msg of messages) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${label}: ${msg.text}`);
  }

  let text = parts.join('\n');

  // If over limit, keep first 20 and last 20 user messages with surrounding context
  if (text.length > MAX_TOTAL_CHARS) {
    const userIndices = messages
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter(i => i !== -1);

    if (userIndices.length > 40) {
      const keepIndices = new Set<number>();
      const first20 = userIndices.slice(0, 20);
      const last20 = userIndices.slice(-20);

      for (const idx of [...first20, ...last20]) {
        keepIndices.add(idx);
        // Include the preceding assistant message if any
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

      // Add truncation marker
      const firstLast20Idx = last20[0];
      const insertPos = parts.findIndex((_, i) => {
        const originalIdx = Array.from(keepIndices).sort((a, b) => a - b)[i];
        return originalIdx >= firstLast20Idx;
      });
      if (insertPos > 0) {
        parts.splice(insertPos, 0, '\n[... middle of conversation truncated ...]\n');
      }

      text = parts.join('\n');
    }
  }

  return text;
}
