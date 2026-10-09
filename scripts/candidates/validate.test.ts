import { BdiffError } from '@bdiff/core';
import { createTestLogger, STUB_RECIPE } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import type { Candidate } from './schema.js';
import { validateCandidates } from './validate.js';

const candidate = (id: string, headRef: string): Candidate => ({
  id,
  repoUrl: 'https://github.com/acme/shop.git',
  prNumber: 1,
  baseRef: 'a'.repeat(40),
  headRef,
  tags: { difficulty: 'easy', prType: 'ui', author: 'human' },
  title: id,
  url: 'https://github.com/acme/shop/pull/1',
  author: 'octocat',
  mergedAt: '2026-08-01T00:00:00Z',
  changedFiles: [],
  repo: {
    fullName: 'acme/shop',
    stars: 500,
    signals: {
      appRoot: '.',
      router: 'app',
      database: 'none',
      dockerCompose: false,
      envExample: false,
      envSchema: false,
      monorepo: false,
    },
  },
  score: 1,
});

describe('validateCandidates', () => {
  it('records the recipe confidence, or the error of a candidate bdiff cannot prepare', async () => {
    const targets: string[] = [];
    const validated = await validateCandidates(
      [candidate('ok', 'good'), candidate('bad', 'bad')],
      (target) => {
        targets.push(`${target.headRef}#${String(target.prNumber)}`);
        return target.headRef === 'good'
          ? Promise.resolve({ ...STUB_RECIPE, confidence: 'medium' })
          : Promise.reject(new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found'));
      },
      createTestLogger(),
    );

    expect(targets).toEqual(['good#1', 'bad#1']);
    expect(validated.map((c) => c.validation)).toEqual([
      { status: 'ok', confidence: 'medium' },
      { status: 'failed', code: 'SETUP_UNSUPPORTED', message: 'no Next.js app found' },
    ]);
  });

  it('stops on an interrupt', async () => {
    await expect(
      validateCandidates(
        [candidate('a', 'x')],
        () => Promise.reject(new BdiffError('ABORTED', 'Interrupted')),
        createTestLogger(),
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
