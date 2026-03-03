/**
 * Shared JSONL parsing utilities
 */

export function extractResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('\n');
  }
  return '';
}

export function isUserRejection(resultText: string): boolean {
  return resultText.startsWith("The user doesn't want");
}
