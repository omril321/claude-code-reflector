/**
 * Types for session index entries and JSONL parsing
 */

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

export interface RawJSONLEntry {
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  type: string;
  summary?: string;
  message?: {
    role: string;
    content: unknown;
    id?: string;
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  toolUse?: unknown;
  toolUseResult?: unknown;
  isSidechain?: boolean;
}

export interface CondensedSession {
  sessionId: string;
  projectPath: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  conversationText: string;
  skillsUsed: string[];
}
