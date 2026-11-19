import { z } from 'zod';
import { MockIntentExtractor } from './mock-intent.js';
import { localBaseUrl, OllamaIntentExtractor } from './ollama-intent.js';

export function configuredExtractor(environment: Record<string, string | undefined>) {
  const config = z.object({
    AI_PROVIDER: z.enum(['mock', 'ollama']).default('mock'),
    OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(25000).default(20000),
  }).safeParse(environment);
  if (!config.success) throw new Error('Invalid AI configuration. Check AI_PROVIDER, OLLAMA_BASE_URL and AI_TIMEOUT_MS.');
  const baseUrl = localBaseUrl(config.data.OLLAMA_BASE_URL);
  return config.data.AI_PROVIDER === 'mock' ? new MockIntentExtractor() :
    new OllamaIntentExtractor({ baseUrl, timeoutMs: config.data.AI_TIMEOUT_MS });
}
