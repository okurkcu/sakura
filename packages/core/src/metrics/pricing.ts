import { z } from 'zod';

import type { TokenUsage } from './run-record.js';
import type { FileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';

const pricePerMTok = z.number().nonnegative();

/** Prices for one prompt-length tier, in USD per million tokens. */
export const PriceTierSchema = z.strictObject({
  /** Upper bound of the tier (inclusive), in prompt tokens. Omitted on the last, unbounded tier. */
  upToPromptTokens: z.number().int().positive().exactOptional(),
  inputPerMTok: pricePerMTok,
  outputPerMTok: pricePerMTok,
  cacheReadPerMTok: pricePerMTok,
  cacheWrite5mPerMTok: pricePerMTok,
  cacheWrite1hPerMTok: pricePerMTok,
});
export type PriceTier = z.infer<typeof PriceTierSchema>;

/**
 * Price tiers of one model, ordered by `upToPromptTokens`. Most models have a single unbounded
 * tier; some (e.g. Claude Haiku 5.5) charge more for long prompts.
 */
export const ModelPricingSchema = z.strictObject({
  tiers: z
    .array(PriceTierSchema)
    .min(1)
    .superRefine((tiers, ctx) => {
      tiers.forEach((tier, index) => {
        const isLast = index === tiers.length - 1;
        if (isLast !== (tier.upToPromptTokens === undefined)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'upToPromptTokens'],
            message: 'every tier but the last needs upToPromptTokens; the last must not have it',
          });
        }
        const previous = tiers[index - 1]?.upToPromptTokens;
        if (
          previous !== undefined &&
          tier.upToPromptTokens !== undefined &&
          tier.upToPromptTokens <= previous
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'upToPromptTokens'],
            message: 'tiers must be in ascending order',
          });
        }
      });
    }),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

/** The contents of `config/pricing.json`. */
export const PricingTableSchema = z.strictObject({
  currency: z.literal('USD'),
  /** Where the prices were taken from. */
  source: z.url(),
  /** When the prices were last checked against the source (YYYY-MM-DD). */
  retrievedAt: z.iso.date(),
  /** Keyed by model id exactly as sent in API requests. */
  models: z.record(z.string().min(1), ModelPricingSchema),
});
export type PricingTable = z.infer<typeof PricingTableSchema>;

/** Converts token usage to dollars. */
export interface CostCalculator {
  /**
   * Cost of one LLM call in USD. The prompt-length tier is chosen by the call's prompt tokens
   * (uncached input + cache reads + cache writes); every token of the call is then billed at
   * that tier.
   *
   * @throws BdiffError `CONFIG_INVALID` if the model has no entry in the pricing table.
   */
  costUsd(usage: TokenUsage): number;
}

/** Picodollars per USD: prices are converted to integer picodollars per token for exact sums. */
const PICO_PER_USD = 1e12;

/** Creates a {@link CostCalculator} over a validated pricing table. */
export function createCostCalculator(table: PricingTable): CostCalculator {
  return {
    costUsd: (usage) => {
      const pricing = table.models[usage.model];
      if (pricing === undefined) {
        throw new BdiffError(
          'CONFIG_INVALID',
          `No price for model "${usage.model}" in pricing table`,
          {
            details: { model: usage.model, knownModels: Object.keys(table.models) },
          },
        );
      }
      const tier = selectTier(pricing, promptTokens(usage));
      const picodollars =
        usage.inputTokens * picoPerToken(tier.inputPerMTok) +
        usage.outputTokens * picoPerToken(tier.outputPerMTok) +
        usage.cacheReadTokens * picoPerToken(tier.cacheReadPerMTok) +
        usage.cacheWrite5mTokens * picoPerToken(tier.cacheWrite5mPerMTok) +
        usage.cacheWrite1hTokens * picoPerToken(tier.cacheWrite1hPerMTok);
      return picodollars / PICO_PER_USD;
    },
  };
}

/**
 * Reads and validates a pricing table.
 *
 * @throws BdiffError `CONFIG_INVALID` if the file is not valid JSON or doesn't match the schema.
 */
export async function loadPricingTable(fs: FileSystem, path: string): Promise<PricingTable> {
  const text = await fs.readFile(path);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new BdiffError('CONFIG_INVALID', `Pricing table is not valid JSON: ${path}`, {
      cause: error,
      details: { path },
    });
  }
  const parsed = PricingTableSchema.safeParse(json);
  if (!parsed.success) {
    throw new BdiffError('CONFIG_INVALID', `Pricing table is invalid: ${path}`, {
      cause: parsed.error,
      details: { path, issues: z.prettifyError(parsed.error) },
    });
  }
  return parsed.data;
}

function promptTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens
  );
}

function selectTier(pricing: ModelPricing, prompt: number): PriceTier {
  const tier = pricing.tiers.find(
    (candidate) => candidate.upToPromptTokens === undefined || prompt <= candidate.upToPromptTokens,
  );
  if (tier === undefined) {
    // The schema guarantees an unbounded last tier, so this is unreachable for validated tables.
    throw new BdiffError('INTERNAL', 'Pricing has no tier for this prompt length', {
      details: { promptTokens: prompt },
    });
  }
  return tier;
}

/** Integer picodollars per token. Exact for prices with up to six decimal places. */
function picoPerToken(usdPerMTok: number): number {
  return Math.round(usdPerMTok * 1e6);
}
