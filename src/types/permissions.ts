/**
 * Types for permission analysis
 */

export interface ToolUseRecord {
  toolName: string;
  keyParam: string;
  approved: boolean;
  sessionId: string;
  projectPath: string;
}

export interface PermissionPattern {
  pattern: string;
  approvalCount: number;
  rejectionCount: number;
  sessionIds: string[];
  projectPaths: string[];
}

export interface PermissionSuggestion {
  pattern: string;
  approvalCount: number;
  sessionCount: number;
  scope: 'global' | 'project';
  scopeDetail?: string;
  safetyReason: string;
  notes?: string[];
}

export interface PermissionReport {
  generatedAt: string;
  sessionsScanned: number;
  totalToolUses: number;
  alreadyCovered: number;
  suggestions: PermissionSuggestion[];
  skipped: Array<{ pattern: string; reason: string; approvalCount: number }>;
}
