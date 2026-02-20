/**
 * Types for analysis findings and reports
 */

export type FlagType = 'missing-rule' | 'skill-unused' | 'skill-correction';

export interface Tier1Flag {
  type: FlagType;
  excerpt: string;
  whatHappened: string;
  recommendation: string;
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

export interface Tier2Verdict {
  originalFinding: Tier1Flag;
  verified: boolean;
  reasoning: string;
  refinedRecommendation?: string;
  refinedSuggestedRule?: string;
  evidence: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface Tier2Result {
  sessionId: string;
  projectPath: string;
  summary: string;
  verdicts: Tier2Verdict[];
  confirmedCount: number;
  rejectedCount: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface VerificationReport {
  generatedAt: string;
  sourceReport: string;
  model: string;
  sessionsVerified: number;
  findingsInput: number;
  findingsConfirmed: number;
  findingsRejected: number;
  estimatedCost: number;
  results: Tier2Result[];
}
