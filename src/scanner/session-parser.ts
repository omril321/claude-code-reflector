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
const TOOL_PARAM_CHARS = 300;
const TOOL_ERROR_CHARS = 800;

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
  const toolUseNames: Map<string, string> = new Map();

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

      // Extract skill usage and track all tool_use IDs
      if (role === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
            skillsUsed.add(block.input.skill as string);
          }
          if (block.type === 'tool_use' && block.id && block.name) {
            toolUseNames.set(block.id as string, block.name as string);
          }
        }
      }

      const text = extractText(content, role, full);
      const toolContext = extractToolContext(content, role, toolUseNames);
      const combined = [text, ...toolContext].filter(Boolean).join('\n');
      if (!combined) continue;

      messages.push({ role: role as 'user' | 'assistant', text: combined });
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

/**
 * Extract tool context (commands, errors, rejections) from content blocks
 */
function extractToolContext(
  content: unknown,
  role: string,
  toolUseNames: Map<string, string>,
): string[] {
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;

    // Tool invocations from assistant messages
    if (role === 'assistant' && block.type === 'tool_use' && block.name) {
      const param = extractKeyParam(block.name as string, block.input);
      if (param !== null) {
        const name = (block.name as string).toLowerCase();
        lines.push(param ? `[${name}] ${param}` : `[${name}]`);
      }
    }

    // Tool results from user messages
    if (
      role === 'user' &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      toolUseNames.has(block.tool_use_id as string)
    ) {
      const resultText = extractResultContent(block.content);
      if (!resultText) continue;

      if (isUserRejection(resultText)) {
        const feedback = extractRejectionFeedback(resultText);
        lines.push(feedback ? `[rejected] ${feedback}` : '[rejected]');
      } else if (isToolError(block, resultText)) {
        lines.push('[error] ' + truncate(resultText, TOOL_ERROR_CHARS));
      }
    }
  }

  return lines;
}

const KEY_PARAM_MAP: Record<string, string> = {
  Bash: 'command',
  Edit: 'file_path',
  Write: 'file_path',
  Read: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  Task: 'description',
  WebSearch: 'query',
  WebFetch: 'url',
};

function extractKeyParam(toolName: string, input: unknown): string | null {
  // Skip Skill — already tracked in skillsUsed
  if (toolName === 'Skill') return null;

  if (!input || typeof input !== 'object') return '';

  const paramKey = KEY_PARAM_MAP[toolName];
  if (paramKey) {
    const value = (input as Record<string, unknown>)[paramKey];
    if (typeof value === 'string') {
      return truncate(value, TOOL_PARAM_CHARS);
    }
    return '';
  }

  // Unknown tool — use first string value from input
  for (const val of Object.values(input as Record<string, unknown>)) {
    if (typeof val === 'string') {
      return truncate(val, TOOL_PARAM_CHARS);
    }
  }
  return '';
}

function extractResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('\n');
  }
  return '';
}

function isUserRejection(resultText: string): boolean {
  return resultText.startsWith('The user doesn\'t want');
}

function isToolError(block: Record<string, unknown>, resultText: string): boolean {
  if (block.is_error === true) return true;
  if (/Exit code [^0]/.test(resultText)) return true;
  return false;
}

function extractRejectionFeedback(resultText: string): string {
  const marker = 'the user said:\n';
  const idx = resultText.toLowerCase().indexOf(marker);
  if (idx === -1) return '';
  return resultText.slice(idx + marker.length).trim();
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
