import { z } from 'zod';

import type { FileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { PricingTable } from '../metrics/pricing.js';

/** Model settings of one tier. */
export const LlmTierConfigSchema = z.strictObject({
  /** Model id as sent to the API; must be in the pricing table. */
  model: z.string().min(1),
  /** How much the model thinks; the main cost lever on current models. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  /**
   * `default`: on a policy decline, the API retries on a fallback model it chooses (server-side
   * fallback beta). Only for models that support it; fallback models must be priced too.
   */
  fallbacks: z.literal('default').exactOptional(),
});
export type LlmTierConfig = z.infer<typeof LlmTierConfigSchema>;

/** The contents of `config/llm.json`. */
export const LlmConfigSchema = z.strictObject({
  tiers: z.strictObject({ fast: LlmTierConfigSchema, smart: LlmTierConfigSchema }),
  /** Timeout of one API request. */
  requestTimeoutMs: z.number().int().positive(),
  /** Automatic retries of rate-limited, overloaded or failed requests (with backoff). */
  maxRetries: z.number().int().min(0).max(10),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/**
 * Reads and validates the LLM configuration, and checks that every configured model has a price,
 * so a run never makes a call it cannot account for.
 *
 * @throws BdiffError `CONFIG_INVALID` for invalid JSON, a schema mismatch or an unpriced model.
 */
export async function loadLlmConfig(
  fs: FileSystem,
  path: string,
  pricing: PricingTable,
): Promise<LlmConfig> {
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(path));
  } catch (error) {
    throw new BdiffError('CONFIG_INVALID', `LLM config is not valid JSON: ${path}`, {
      cause: error,
      details: { path },
    });
  }
  const parsed = LlmConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new BdiffError('CONFIG_INVALID', `LLM config is invalid: ${path}`, {
      cause: parsed.error,
      details: { path, issues: z.prettifyError(parsed.error) },
    });
  }
  for (const [tier, settings] of Object.entries(parsed.data.tiers)) {
    if (pricing.models[settings.model] === undefined) {
      throw new BdiffError(
        'CONFIG_INVALID',
        `LLM tier "${tier}" uses unpriced model "${settings.model}"`,
        {
          details: { path, tier, model: settings.model },
        },
      );
    }
  }
  return parsed.data;
}
