import type { PullRequest } from '@bdiff/core';
import { describe, expect, it } from 'vitest';

import {
  parsePullRequestUrl,
  PULL_REQUEST_TIMEOUT_MS,
  pullRequestTarget,
  resolvePullRequestTarget,
  unresolvedPullRequestTarget,
} from './pr-url.js';

describe('parsePullRequestUrl', () => {
  const ref = { owner: 'vercel', name: 'commerce', number: 1234 };

  it.each([
    ['https://github.com/vercel/commerce/pull/1234', ref],
    ['https://github.com/vercel/commerce/pull/1234/', ref],
    ['https://github.com/vercel/commerce/pull/1234/files', ref],
    ['https://github.com/vercel/commerce/pull/1234/commits/', ref],
    ['https://github.com/vercel/commerce/pull/1234/checks', ref],
    ['https://github.com/vercel/commerce/pull/1234?diff=split', ref],
    ['https://github.com/vercel/commerce/pull/1234/files#diff-abc', ref],
    ['https://www.github.com/vercel/commerce/pull/1234', ref],
    ['  https://github.com/vercel/commerce/pull/1234  ', ref],
    ['https://github.com/a-b/c.d_e/pull/1', { owner: 'a-b', name: 'c.d_e', number: 1 }],
  ])('parses %s', (url, expected) => {
    expect(parsePullRequestUrl(url)).toEqual(expected);
  });

  it.each([
    'http://github.com/vercel/commerce/pull/1234',
    'https://github.com/vercel/commerce/issues/1234',
    'https://github.com/vercel/commerce/pulls',
    'https://github.com/vercel/commerce/pull/0',
    'https://github.com/vercel/commerce/pull/12a',
    'https://github.com/vercel/commerce/pull/1234/files/extra',
    'https://github.com/vercel/commerce',
    'https://github.com/vercel/../pull/1',
    'https://github.example.com/vercel/commerce/pull/1234',
    'https://gitlab.com/vercel/commerce/-/merge_requests/1234',
    'github.com/vercel/commerce/pull/1234',
    'vercel/commerce#1234',
  ])('rejects %s', (url) => {
    expect(parsePullRequestUrl(url)).toBeUndefined();
  });
});

describe('pullRequestTarget', () => {
  const ref = { owner: 'acme', name: 'shop', number: 7 };
  const pr = (overrides: Partial<PullRequest>): PullRequest => ({
    title: 'Format totals',
    body: 'Why and how.',
    state: 'open',
    merged: false,
    base: { ref: 'main', sha: 'a'.repeat(40), repo: 'acme/shop' },
    head: { ref: 'format-totals', sha: 'b'.repeat(40), repo: 'acme/shop' },
    ...overrides,
  });
  const fork = { ref: 'main', sha: 'b'.repeat(40), repo: 'someone/shop' };

  it.each<[string, Partial<PullRequest>, { baseRef: string; headRef: string }]>([
    ['an open PR from the base repository', {}, { baseRef: 'main', headRef: 'format-totals' }],
    // The fork's `main` must not be mistaken for the base repository's `main`.
    ['an open fork PR', { head: fork }, { baseRef: 'main', headRef: 'b'.repeat(40) }],
    [
      'a merged PR, whose base branch already holds its changes',
      { state: 'closed', merged: true },
      { baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40) },
    ],
    [
      'a closed fork PR whose fork was deleted',
      { state: 'closed', head: { ref: 'main', sha: 'b'.repeat(40), repo: null } },
      { baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40) },
    ],
    [
      'an open PR, repository names differing in case',
      { head: { ref: 'fix', sha: 'b'.repeat(40), repo: 'ACME/Shop' } },
      { baseRef: 'main', headRef: 'fix' },
    ],
  ])('maps %s', (_name, overrides, refs) => {
    expect(pullRequestTarget(ref, pr(overrides))).toEqual({
      repoUrl: 'https://github.com/acme/shop',
      ...refs,
      prNumber: 7,
      prTitle: 'Format totals',
      prBody: 'Why and how.',
    });
  });

  it("uses the base repository's canonical name", () => {
    expect(
      pullRequestTarget(
        { owner: 'Acme', name: 'SHOP', number: 7 },
        pr({ base: { ref: 'main', sha: 'a'.repeat(40), repo: 'acme/shop' } }),
      ).repoUrl,
    ).toBe('https://github.com/acme/shop');
  });
});

describe('resolvePullRequestTarget / unresolvedPullRequestTarget', () => {
  const ref = { owner: 'acme', name: 'shop', number: 7 };

  it('asks the source with a timeout and the run signal', async () => {
    const signal = new AbortController().signal;
    const calls: unknown[] = [];

    const target = await resolvePullRequestTarget(
      ref,
      {
        resolvePullRequest: (repo, number, options) => {
          calls.push([repo.owner, repo.name, number, options]);
          return Promise.resolve({
            title: 't',
            body: '',
            state: 'open',
            merged: false,
            base: { ref: 'main', sha: 'a'.repeat(40), repo: 'acme/shop' },
            head: { ref: 'x', sha: 'b'.repeat(40), repo: 'acme/shop' },
          });
        },
      },
      signal,
    );

    expect(calls).toEqual([['acme', 'shop', 7, { timeoutMs: PULL_REQUEST_TIMEOUT_MS, signal }]]);
    expect(target.headRef).toBe('x');
  });

  it('records an unresolved PR by its repository and number', () => {
    expect(unresolvedPullRequestTarget(ref)).toEqual({
      repoUrl: 'https://github.com/acme/shop',
      baseRef: 'HEAD',
      headRef: 'refs/pull/7/head',
      prNumber: 7,
    });
  });
});
