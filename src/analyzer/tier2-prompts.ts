/**
 * Prompt templates for Tier 2 deep verification
 */

import type { SkillInfo } from '../scanner/skill-catalog.js';
import type { Tier1Flag } from '../types/findings.js';

export function buildTier2SystemPrompt(
  claudeMdContent: string,
  relevantSkills: SkillInfo[],
): string {
  const skillList = relevantSkills
    .map(s => `### ${s.name}\n**Description:** ${s.description}\n\n${s.content}`)
    .join('\n\n---\n\n');

  return `You are a meticulous verification agent. You receive candidate findings from a fast initial scan of a Claude Code session, along with the FULL untruncated conversation. Your job is to verify or reject each finding based on the complete evidence.

You are NOT looking for new findings. You are ONLY evaluating the specific findings provided.

## Verification Criteria

For each finding, determine:

### missing-rule
- Does the full conversation actually show the user giving this instruction?
- Was it a one-time clarification for this specific task, or a generalizable preference that would apply across future sessions?
- Is it genuinely non-obvious? Standard practices ("test before committing", "verify docs against code", "check your work", "double check yourself") are NOT rules — regardless of how emphatically the user stated them.
- Is it already covered by an existing CLAUDE.md rule? Check carefully against the rules below.
- Would a reasonable AI developer follow this convention without being told?
- Is it already covered by an available skill? If so, the skill should be updated instead — reject the missing-rule finding.

### skill-unused
- In the full conversation, was the skill's use case genuinely present?
- Read the skill's full content carefully. Is the triggering description truly missing coverage for this scenario? If the trigger already describes this situation, reject — the skill was correctly described and the issue is elsewhere.
- Would using the skill have meaningfully changed the outcome?
- Was there a reason the user might have intentionally not wanted the skill invoked?

### skill-correction
- Did the user genuinely correct behavior AFTER the skill was used?
- Is the correction about the skill's output specifically, or about something unrelated to the skill?
- Is the correction repeatable — would it happen again in similar sessions?
- Can the skill be reasonably updated to prevent this issue?

## Verdict Standards

- **REJECT** if: evidence is ambiguous, instruction was one-time/task-specific, behavior is standard practice, skill trigger already covers the scenario, or the finding misreads the conversation.
- **CONFIRM** only if: clear evidence exists in the full conversation, the issue is genuinely generalizable, and the recommendation is actionable.
- When confirming: refine the recommendation to be as specific and grounded as possible. Reference concrete details from the full conversation.
- Re-assess confidence based on the full evidence (may differ from the initial scan's assessment).

## Current CLAUDE.md Rules
\`\`\`
${claudeMdContent}
\`\`\`

## Relevant Skills
${skillList || '(none referenced by findings)'}

## Output Format
Respond with ONLY a JSON array. One verdict per input finding, in the same order as the input.
\`\`\`
[
  {
    "findingIndex": 0,
    "verified": true,
    "reasoning": "2-3 sentence explanation of why this finding is confirmed or rejected",
    "refinedRecommendation": "If verified: improved, specific recommendation grounded in conversation evidence. Omit if rejected.",
    "refinedSuggestedRule": "If verified missing-rule: improved rule text. Omit otherwise.",
    "evidence": ["Quote from conversation showing the pattern", "Another supporting quote"],
    "confidence": "low" | "medium" | "high"
  }
]
\`\`\``;
}

export function buildTier2UserMessage(
  findings: Tier1Flag[],
  conversationText: string,
  skillsUsed: string[],
): string {
  const skillsUsedSection = skillsUsed.length > 0
    ? skillsUsed.map(s => `- ${s}`).join('\n')
    : '(none)';

  const findingsJson = JSON.stringify(
    findings.map((f, i) => ({ index: i, ...f })),
    null,
    2,
  );

  return `## Candidate Findings to Verify
\`\`\`json
${findingsJson}
\`\`\`

## Skills Used in This Session
${skillsUsedSection}

## Full Conversation
---
${conversationText}
---`;
}
