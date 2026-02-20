/**
 * Tier 1 (Haiku) quick-scan analysis
 */

import type { CondensedSession } from '../types/session.js';
import type { Tier1Flag, Tier1Result } from '../types/findings.js';
import type { ContextInfo } from '../scanner/skill-catalog.js';
import { callHaiku } from './anthropic-client.js';
import { buildTier1SystemPrompt, buildTier1UserMessage } from './prompts.js';

/**
 * Run Tier 1 analysis on a single session
 */
export async function analyzeTier1(
  session: CondensedSession,
  context: ContextInfo,
): Promise<Tier1Result> {
  const system = buildTier1SystemPrompt(context.claudeMdContent, context.skills);
  const userMessage = buildTier1UserMessage(session.conversationText);

  const response = await callHaiku(system, userMessage);

  let flags: Tier1Flag[] = [];
  try {
    // Extract JSON from response (handle potential markdown wrapping)
    let jsonText = response.text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      flags = parsed.filter(isValidFlag);
    }
  } catch {
    // If parsing fails, treat as no findings
    flags = [];
  }

  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    summary: session.summary,
    flags,
    tokenUsage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function isValidFlag(obj: unknown): obj is Tier1Flag {
  if (typeof obj !== 'object' || obj === null) return false;
  const flag = obj as Record<string, unknown>;
  const validTypes = ['missing-rule', 'skill-unused', 'skill-correction'];
  const validConfidences = ['low', 'medium', 'high'];
  return (
    typeof flag.type === 'string' &&
    validTypes.includes(flag.type) &&
    typeof flag.excerpt === 'string' &&
    typeof flag.whatHappened === 'string' &&
    typeof flag.recommendation === 'string' &&
    typeof flag.confidence === 'string' &&
    validConfidences.includes(flag.confidence)
  );
}
