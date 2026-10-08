import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCostCalculator, loadPricingTable, PricingTableSchema } from './pricing.js';
import type { PricingTable } from './pricing.js';
import type { TokenUsage } from './run-record.js';
import type { FileSystem } from '../adapters/file-system.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';

const repoPricingPath = path.resolve(import.meta.dirname, '../../../../config/pricing.json');

function usage(model: string, tokens: Partial<Omit<TokenUsage, 'model'>> = {}): TokenUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    ...tokens,
  };
}

const flat = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWrite5mPerMTok: 3.75,
  cacheWrite1hPerMTok: 6,
};

const fixtureTable: PricingTable = {
  currency: 'USD',
  source: 'https://example.com/pricing',
  retrievedAt: '2026-01-01',
  models: {
    flat: { tiers: [flat] },
    tiered: {
      tiers: [
        { ...flat, upToPromptTokens: 1_000, inputPerMTok: 1, outputPerMTok: 2 },
        { ...flat, upToPromptTokens: 2_000, inputPerMTok: 10, outputPerMTok: 20 },
        { ...flat, inputPerMTok: 100, outputPerMTok: 200 },
      ],
    },
  },
};

describe('createCostCalculator (fixture table)', () => {
  const costs = createCostCalculator(fixtureTable);

  it.each([
    { name: 'zero usage', tokens: {}, expected: 0 },
    { name: 'input only', tokens: { inputTokens: 1_000_000 }, expected: 3 },
    { name: 'output only', tokens: { outputTokens: 2_000 }, expected: 0.03 },
    {
      name: 'every category',
      // 1000×3 + 1000×15 + 10000×0.3 + 2000×3.75 + 1000×6 = 34_500 → $0.0345
      tokens: {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cacheReadTokens: 10_000,
        cacheWrite5mTokens: 2_000,
        cacheWrite1hTokens: 1_000,
      },
      expected: 0.0345,
    },
  ])('prices $name', ({ tokens, expected }) => {
    expect(costs.costUsd(usage('flat', tokens))).toBeCloseTo(expected, 12);
  });

  it.each([
    {
      name: 'first tier',
      tokens: { inputTokens: 1_000, outputTokens: 1_000 },
      expected: (1_000 * 1 + 1_000 * 2) / 1e6,
    },
    {
      name: 'second tier',
      tokens: { inputTokens: 1_001, outputTokens: 1_000 },
      expected: (1_001 * 10 + 1_000 * 20) / 1e6,
    },
    { name: 'last, unbounded tier', tokens: { inputTokens: 5_000 }, expected: (5_000 * 100) / 1e6 },
    {
      name: 'tier chosen by input plus cache tokens, not output',
      tokens: {
        inputTokens: 500,
        cacheReadTokens: 400,
        cacheWrite5mTokens: 101,
        outputTokens: 50_000,
      },
      expected: (500 * 10 + 400 * 0.3 + 101 * 3.75 + 50_000 * 20) / 1e6,
    },
  ])('applies the $name', ({ tokens, expected }) => {
    expect(costs.costUsd(usage('tiered', tokens))).toBeCloseTo(expected, 12);
  });

  it('throws CONFIG_INVALID for a model without a price', () => {
    const error = (() => {
      try {
        costs.costUsd(usage('claude-unknown'));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(BdiffError);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', details: { model: 'claude-unknown' } });
  });
});

describe('config/pricing.json: hand-computed costs', () => {
  it.each([
    {
      // 10_000×$2 + 2_000×$10 + 50_000×$0.10 + 4_000×$2.50 = 55_000 µ$ → $0.055
      model: 'claude-sonnet-5-5',
      tokens: {
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadTokens: 50_000,
        cacheWrite5mTokens: 4_000,
      },
      expected: 0.055,
    },
    {
      // prompt 55_000 ≤ 100k: 20_000×$0.10 + 1_000×$0.50 + 30_000×$0.01 + 5_000×$0.20 = 3_800 µ$ → $0.0038
      model: 'claude-haiku-5-5',
      tokens: {
        inputTokens: 20_000,
        outputTokens: 1_000,
        cacheReadTokens: 30_000,
        cacheWrite1hTokens: 5_000,
      },
      expected: 0.0038,
    },
    {
      // prompt 110_000 > 100k: 90_000×$0.50 + 4_000×$2.50 + 20_000×$0.05 = 56_000 µ$ → $0.056
      model: 'claude-haiku-5-5',
      tokens: { inputTokens: 90_000, outputTokens: 4_000, cacheReadTokens: 20_000 },
      expected: 0.056,
    },
    {
      // exactly 100_000 prompt tokens stays in the cheaper tier: 100_000×$0.10 → $0.01
      model: 'claude-haiku-5-5',
      tokens: { inputTokens: 100_000 },
      expected: 0.01,
    },
    {
      // one token over: 100_001×$0.50 → $0.0500005
      model: 'claude-haiku-5-5',
      tokens: { inputTokens: 100_001 },
      expected: 0.0500005,
    },
    {
      // 1M×$1 + 1M×$5 → $6
      model: 'claude-haiku-4-5',
      tokens: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      expected: 6,
    },
  ])('$model: $expected USD', async ({ model, tokens, expected }) => {
    const costs = createCostCalculator(await loadPricingTable(nodeFileSystem, repoPricingPath));

    expect(costs.costUsd(usage(model, tokens))).toBeCloseTo(expected, 12);
  });
});

describe('loadPricingTable', () => {
  const fsWith = (text: string): FileSystem => ({
    ...nodeFileSystem,
    readFile: () => Promise.resolve(text),
  });

  it('loads the repository pricing table', async () => {
    const table = await loadPricingTable(nodeFileSystem, repoPricingPath);

    expect(Object.keys(table.models)).toEqual(
      expect.arrayContaining(['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5']),
    );
  });

  it('rejects malformed JSON with CONFIG_INVALID', async () => {
    await expect(loadPricingTable(fsWith('{ nope'), 'pricing.json')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it.each([
    {
      name: 'a negative price',
      models: { m: { tiers: [{ ...flat, inputPerMTok: -1 }] } },
    },
    {
      name: 'a bounded last tier',
      models: { m: { tiers: [{ ...flat, upToPromptTokens: 100 }] } },
    },
    {
      name: 'an unbounded middle tier',
      models: { m: { tiers: [flat, flat] } },
    },
    {
      name: 'tiers out of order',
      models: {
        m: {
          tiers: [{ ...flat, upToPromptTokens: 200 }, { ...flat, upToPromptTokens: 100 }, flat],
        },
      },
    },
    {
      name: 'a missing price',
      models: { m: { tiers: [{ inputPerMTok: 1, outputPerMTok: 1 }] } },
    },
    { name: 'no tiers', models: { m: { tiers: [] } } },
  ])('rejects $name with CONFIG_INVALID', async ({ models }) => {
    const text = JSON.stringify({ ...fixtureTable, models });

    await expect(loadPricingTable(fsWith(text), 'pricing.json')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('accepts the fixture table', () => {
    expect(PricingTableSchema.parse(fixtureTable)).toEqual(fixtureTable);
  });
});
