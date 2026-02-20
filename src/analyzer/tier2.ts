/**
 * Tier 2 deep verification — verifies Tier 1 candidate findings
 * against the full, untruncated session conversation
 */

import type { SessionIndexEntry } from '../types/session.js';
import type { Tier1Flag, Tier2Verdict, Tier2Result } from '../types/findings.js';
import type { ContextInfo } from '../scanner/skill-catalog.js';
import { parseSession } from '../scanner/session-parser.js';
import { callModel } from './anthropic-client.js';
import { buildTier2SystemPrompt, buildTier2UserMessage } from './tier2-prompts.js';

/**
 * Verify Tier 1 findings for a single session using full conversation context
 */
export async function verifySession(
  sessionEntry: SessionIndexEntry,
  flags: Tier1Flag[],
  context: ContextInfo,
  model: string,
): Promise<Tier2Result> {
  const session = await parseSession(sessionEntry, { full: true });

  // Only include skills referenced in findings
  const referencedSkillNames = new Set(
    flags.map(f => f.skillName).filter(Boolean) as string[],
  );
  const relevantSkills = context.skills.filter(
    s => referencedSkillNames.has(s.name),
  );

  const system = buildTier2SystemPrompt(context.claudeMdContent, relevantSkills);
  const userMessage = buildTier2UserMessage(flags, session.conversationText, session.skillsUsed);

  const response = await callModel(system, userMessage, { model, maxTokens: 8192 });

  const verdicts = parseVerdicts(response.text, flags);

  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    summary: session.summary,
    verdicts,
    confirmedCount: verdicts.filter(v => v.verified).length,
    rejectedCount: verdicts.filter(v => !v.verified).length,
    tokenUsage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function parseVerdicts(responseText: string, originalFlags: Tier1Flag[]): Tier2Verdict[] {
  let jsonText = responseText.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim();
  }

  let parsed: unknown[];
  try {
    parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return fallbackVerdicts(originalFlags);
  } catch {
    return fallbackVerdicts(originalFlags);
  }

  return originalFlags.map((flag, i) => {
    const raw = parsed[i];
    if (!raw || typeof raw !== 'object') {
      return {
        originalFinding: flag,
        verified: false,
        reasoning: 'No verdict returned by verification model',
        evidence: [],
        confidence: 'low' as const,
      };
    }

    const v = raw as Record<string, unknown>;
    return {
      originalFinding: flag,
      verified: v.verified === true,
      reasoning: typeof v.reasoning === 'string' ? v.reasoning : 'No reasoning provided',
      refinedRecommendation: typeof v.refinedRecommendation === 'string' ? v.refinedRecommendation : undefined,
      refinedSuggestedRule: typeof v.refinedSuggestedRule === 'string' ? v.refinedSuggestedRule : undefined,
      evidence: Array.isArray(v.evidence) ? v.evidence.filter((e): e is string => typeof e === 'string') : [],
      confidence: isValidConfidence(v.confidence) ? v.confidence : flag.confidence,
    };
  });
}

function isValidConfidence(val: unknown): val is 'low' | 'medium' | 'high' {
  return val === 'low' || val === 'medium' || val === 'high';
}

function fallbackVerdicts(flags: Tier1Flag[]): Tier2Verdict[] {
  return flags.map(flag => ({
    originalFinding: flag,
    verified: false,
    reasoning: 'Failed to parse verification response',
    evidence: [],
    confidence: 'low' as const,
  }));
}
