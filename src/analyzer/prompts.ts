/**
 * Prompt templates for Tier 1 analysis
 */

import type { SkillInfo } from '../scanner/skill-catalog.js';

export function buildTier1SystemPrompt(
  claudeMdContent: string,
  skills: SkillInfo[],
): string {
  const skillList = skills
    .map(s => `- **${s.name}**: ${s.description}`)
    .join('\n');

  return `You are an expert analyst reviewing Claude Code sessions to identify gaps in the user's configuration.

You will be given a conversation between a user and Claude Code. Your job is to identify:

1. **missing-rule**: Instructions the user gave Claude that should be permanent rules in their CLAUDE.md file, but aren't. Look for:
   - Corrections the user made ("no, use X instead of Y")
   - Repeated preferences ("always do X", "never do Y")
   - Style/convention instructions that aren't in the current rules
   - Workflow preferences that Claude should know automatically

2. **skill-unused**: Skills that were available and clearly relevant to the task, but were never invoked. Only flag this when:
   - The conversation topic strongly matches a skill's purpose
   - Using the skill would have meaningfully improved the outcome
   - Don't flag if the skill is tangentially related

3. **skill-correction**: Skills that WERE used (you'll see "Skill: <name>" in the conversation) but the user had to correct Claude's behavior during or after using it. This indicates the skill itself may need updating.

## Current CLAUDE.md Rules
\`\`\`
${claudeMdContent}
\`\`\`

## Available Skills
${skillList || '(no skills found)'}

## Output Format
Respond with ONLY a JSON array of findings. No markdown, no explanation. Each finding:
\`\`\`
{
  "type": "missing-rule" | "skill-unused" | "skill-correction",
  "excerpt": "Brief quote from the conversation showing the evidence",
  "whatHappened": "One-sentence plain English description of what went wrong in the session",
  "recommendation": "One-sentence concrete action to take next time (start with imperative verb: Add, Use, Invoke)",
  "confidence": "low" | "medium" | "high",
  "suggestedRule": "The rule that should be added to CLAUDE.md (for missing-rule type)",
  "skillName": "Name of the relevant skill (for skill-unused and skill-correction types)"
}
\`\`\`

If there are NO findings, respond with an empty array: []

Be selective - only flag clear, actionable findings. Don't flag:
- One-off project-specific instructions
- Things already covered by existing CLAUDE.md rules
- Vague preferences without clear evidence`;
}

export function buildTier1UserMessage(conversationText: string): string {
  return `Analyze this Claude Code session for missing rules, unused skills, and skill corrections:

---
${conversationText}
---`;
}
