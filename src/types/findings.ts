/**
 * Types for analysis findings and reports
 */

export type FlagType = 'missing-rule' | 'skill-unused' | 'skill-correction';

export interface Tier1Flag {
  type: FlagType;
  excerpt: string;
  reasoning: string;
  confidence: 'low' | 'medium' | 'high';
  suggestedRule?: string;
  skillName?: string;
}

export interface Tier1Result {
  sessionId: string;
  projectPath: string;
  summary: string;
  flags: Tier1Flag[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ReflectorReport {
  generatedAt: string;
  sessionsScanned: number;
  sessionsWithFindings: number;
  totalFindings: number;
  findingsByType: Record<FlagType, number>;
  estimatedCost: number;
  results: Tier1Result[];
}
