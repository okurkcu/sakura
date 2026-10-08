import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadLlmConfig } from './llm-config.js';
import { parseStructuredOutput } from './structured-output.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import type { FileSystem } from '../adapters/file-system.js';
import { loadPricingTable } from '../metrics/pricing.js';

const repoConfig = (file: string) => path.resolve(import.meta.dirname, '../../../../config', file);
const fsWith = (text: string): FileSystem => ({
  ...nodeFileSystem,
  readFile: () => Promise.resolve(text),
});

describe('loadLlmConfig', () => {
  it('loads the repository config: Haiku 5.5 for fast, Sonnet 5.5 with fallback for smart', async () => {
    const pricing = await loadPricingTable(nodeFileSystem, repoConfig('pricing.json'));

    expect(await loadLlmConfig(nodeFileSystem, repoConfig('llm.json'), pricing)).toMatchObject({
      tiers: {
        fast: { model: 'claude-haiku-5-5', effort: 'medium' },
        smart: { model: 'claude-sonnet-5-5', effort: 'medium', fallbacks: 'default' },
      },
    });
  });

  it.each([
    { name: 'invalid JSON', text: '{', match: 'not valid JSON' },
    {
      name: 'an unknown effort',
      text: JSON.stringify({
        tiers: { fast: { model: 'm', effort: 'turbo' }, smart: { model: 'm', effort: 'low' } },
        requestTimeoutMs: 1,
        maxRetries: 0,
      }),
      match: 'invalid',
    },
    {
      name: 'an unpriced model',
      text: JSON.stringify({
        tiers: {
          fast: { model: 'claude-mystery', effort: 'low' },
          smart: { model: 'claude-sonnet-5-5', effort: 'low' },
        },
        requestTimeoutMs: 1,
        maxRetries: 0,
      }),
      match: 'unpriced model "claude-mystery"',
    },
  ])('rejects $name with CONFIG_INVALID', async ({ text, match }) => {
    const pricing = await loadPricingTable(nodeFileSystem, repoConfig('pricing.json'));

    await expect(loadLlmConfig(fsWith(text), 'llm.json', pricing)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining(match) as string,
    });
  });
});

describe('parseStructuredOutput', () => {
  const schema = z.strictObject({ items: z.array(z.string().min(2)).max(2) });

  it('returns validated data', () => {
    expect(parseStructuredOutput('{"items":["ab"]}', schema)).toEqual({
      ok: true,
      data: { items: ['ab'] },
    });
  });

  it.each([
    ['{"items":', /not valid JSON/],
    ['{"items":["a"]}', /items\.0: .*/],
    ['{"items":["ab","cd","ef"]}', /items: /],
    ['{"items":["ab"],"extra":1}', /\(root\): .*extra/],
    ['[]', /\(root\)/],
  ])('explains why %s is invalid', (text, problem) => {
    const result = parseStructuredOutput(text, schema);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toMatch(problem);
  });
});
