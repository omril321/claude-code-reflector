/**
 * Thin wrapper around the Anthropic Vertex/Bedrock SDKs with retry logic.
 * Auto-detects provider: Vertex if ANTHROPIC_VERTEX_PROJECT_ID is set, Bedrock otherwise.
 */

import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import chalk from 'chalk';

type Provider = 'vertex' | 'bedrock';

let detectedProvider: Provider | null = null;

function getProvider(): Provider {
  if (!detectedProvider) {
    if (process.env.ANTHROPIC_VERTEX_PROJECT_ID) {
      detectedProvider = 'vertex';
      console.log(chalk.dim(`Provider: Vertex AI (ANTHROPIC_VERTEX_PROJECT_ID is set)`));
    } else {
      detectedProvider = 'bedrock';
      console.log(chalk.dim(`Provider: AWS Bedrock (ANTHROPIC_VERTEX_PROJECT_ID not found)`));
    }
  }
  return detectedProvider;
}

let client: AnthropicVertex | AnthropicBedrock | null = null;

function getClient(): AnthropicVertex | AnthropicBedrock {
  if (!client) {
    if (getProvider() === 'vertex') {
      client = new AnthropicVertex({
        region: process.env.CLOUD_ML_REGION,
        projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
      });
    } else {
      client = new AnthropicBedrock();
    }
  }
  return client;
}

const DELAY_MS = 500;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

const VERTEX_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5@20251001',
  sonnet: 'claude-sonnet-4@20250514',
};

const BEDROCK_ALIASES: Record<string, string> = {
  haiku: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  sonnet: 'anthropic.claude-sonnet-4-20250514-v1:0',
};

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5@20251001': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-sonnet-4@20250514': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'anthropic.claude-sonnet-4-20250514-v1:0': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
};

const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 3.0, outputPerMillion: 15.0 };

export function getModelPricing(model: string): ModelPricing {
  const resolved = resolveModelId(model);
  return MODEL_PRICING[resolved] ?? DEFAULT_PRICING;
}

export function resolveModelId(nameOrId: string): string {
  const aliases = getProvider() === 'vertex' ? VERTEX_ALIASES : BEDROCK_ALIASES;
  return aliases[nameOrId] ?? nameOrId;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CallModelOptions {
  model?: string;
  maxTokens?: number;
}

/**
 * Call a model with retry on rate limits
 */
export async function callModel(
  system: string,
  userMessage: string,
  options?: CallModelOptions,
): Promise<LLMResponse> {
  const model = resolveModelId(options?.model ?? 'haiku');
  const maxTokens = options?.maxTokens ?? 4096;

  // Small delay between calls
  await sleep(DELAY_MS);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
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
