/**
 * Thin wrapper around the Anthropic Vertex SDK with retry logic
 */

import AnthropicVertex from '@anthropic-ai/vertex-sdk';

let client: AnthropicVertex | null = null;

function getClient(): AnthropicVertex {
  if (!client) {
    client = new AnthropicVertex({
      region: process.env.CLOUD_ML_REGION,
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    });
  }
  return client;
}

const DELAY_MS = 500;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call the Haiku model with retry on rate limits
 */
export async function callHaiku(
  system: string,
  userMessage: string,
): Promise<LLMResponse> {
  // Small delay between calls
  await sleep(DELAY_MS);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().messages.create({
        model: 'claude-haiku-4-5@20251001',
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0,
      });

      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text response from model');
      }

      return {
        text: textBlock.text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err: unknown) {
      lastError = err as Error;
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 529) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('Max retries exceeded');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
