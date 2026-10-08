import { describe, expect, it } from 'vitest';

import { parseRunConfig } from './config.js';
import type { RunFlags } from './config.js';

const required: RunFlags = { repo: 'https://github.com/acme/shop.git', base: 'main', head: 'pr/1' };

describe('parseRunConfig', () => {
  it('applies defaults', () => {
    expect(parseRunConfig(required, {})).toEqual({
      target: { repoUrl: 'https://github.com/acme/shop.git', baseRef: 'main', headRef: 'pr/1' },
      outDir: '.bdiff',
      timeoutMs: 20 * 60_000,
      budgetUsd: 1,
      logLevel: 'info',
    });
  });

  it('reads environment variables', () => {
    const config = parseRunConfig(required, {
      BDIFF_OUT: '/tmp/out',
      BDIFF_TIMEOUT_MIN: '5',
      BDIFF_BUDGET_USD: '0.25',
      BDIFF_LOG_LEVEL: 'debug',
    });

    expect(config).toMatchObject({
      outDir: '/tmp/out',
      timeoutMs: 300_000,
      budgetUsd: 0.25,
      logLevel: 'debug',
    });
  });

  it('lets flags override environment variables', () => {
    const config = parseRunConfig(
      { ...required, out: 'flag-out', timeout: '1.5', budget: '0', logLevel: 'warn', pr: '42' },
      {
        BDIFF_OUT: 'env-out',
        BDIFF_TIMEOUT_MIN: '5',
        BDIFF_BUDGET_USD: '3',
        BDIFF_LOG_LEVEL: 'debug',
      },
    );

    expect(config).toMatchObject({
      target: { prNumber: 42 },
      outDir: 'flag-out',
      timeoutMs: 90_000,
      budgetUsd: 0,
      logLevel: 'warn',
    });
  });

  it.each([
    {
      name: 'missing repo',
      flags: { base: 'main', head: 'x' },
      env: {},
      message: '--repo is required',
    },
    {
      name: 'empty base',
      flags: { ...required, base: ' ' },
      env: {},
      message: '--base must not be empty',
    },
    {
      name: 'non-numeric pr',
      flags: { ...required, pr: 'abc' },
      env: {},
      message: '--pr must be a positive integer',
    },
    {
      name: 'zero pr',
      flags: { ...required, pr: '0' },
      env: {},
      message: '--pr must be a positive integer',
    },
    { name: 'zero timeout', flags: { ...required, timeout: '0' }, env: {}, message: 'more than 0' },
    {
      name: 'huge timeout',
      flags: { ...required, timeout: '5000' },
      env: {},
      message: 'at most 1440',
    },
    {
      name: 'negative budget',
      flags: { ...required, budget: '-1' },
      env: {},
      message: 'non-negative number',
    },
    {
      name: 'huge budget',
      flags: { ...required, budget: '500' },
      env: {},
      message: 'at most 100 USD',
    },
    {
      name: 'bad env timeout',
      flags: required,
      env: { BDIFF_TIMEOUT_MIN: 'soon' },
      message: 'non-negative number',
    },
    {
      name: 'unknown log level',
      flags: { ...required, logLevel: 'loud' },
      env: {},
      message: 'log level must be one of',
    },
    {
      name: 'ref that git parses as an option',
      flags: { ...required, head: '--upload-pack=x' },
      env: {},
      message: 'must not start with "-"',
    },
  ])('rejects $name', ({ flags, env, message }) => {
    expect(() => parseRunConfig(flags, env)).toThrow(message);
    expect(() => parseRunConfig(flags, env)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('reports every problem at once', () => {
    expect(() => parseRunConfig({ base: 'main', head: 'x', pr: 'x', timeout: '0' }, {})).toThrow(
      /--repo is required[\s\S]*--pr must be a positive integer[\s\S]*more than 0/,
    );
  });
});
