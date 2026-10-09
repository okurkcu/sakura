import { describe, expect, it } from 'vitest';

import { candidatesMarkdown } from './markdown.js';
import { capPerRepo, rankCandidates, scoreCandidate } from './rank.js';
import type { Candidate } from './schema.js';

const candidate = (repo: string, number: number, score: number): Candidate => ({
  id: `${repo.replace('/', '-')}-${String(number)}`,
  repoUrl: `https://github.com/${repo}.git`,
  prNumber: number,
  baseRef: 'a'.repeat(40),
  headRef: 'b'.repeat(40),
  tags: { difficulty: 'easy', prType: 'ui', author: 'human' },
  title: `PR ${String(number)} | with a pipe`,
  url: `https://github.com/${repo}/pull/${String(number)}`,
  author: 'octocat',
  mergedAt: '2026-09-01T00:00:00Z',
  changedFiles: ['app/page.tsx'],
  repo: {
    fullName: repo,
    stars: 1_000,
    signals: {
      appRoot: '.',
      router: 'app',
      database: 'none',
      dockerCompose: false,
      envExample: true,
      envSchema: false,
      monorepo: false,
    },
  },
  score,
});

describe('scoreCandidate', () => {
  it('prefers UI and API changes, easy setups and small PRs', () => {
    expect(scoreCandidate({ prType: 'ui', difficulty: 'easy' }, 0)).toBe(1);
    expect(scoreCandidate({ prType: 'api', difficulty: 'easy' }, 30)).toBe(0.5);
    expect(scoreCandidate({ prType: 'refactor', difficulty: 'realistic' }, 6)).toBe(0.378);
    expect(scoreCandidate({ prType: 'mixed', difficulty: 'easy' }, 3)).toBeGreaterThan(
      scoreCandidate({ prType: 'refactor', difficulty: 'easy' }, 3),
    );
    expect(scoreCandidate({ prType: 'ui', difficulty: 'easy' }, 100)).toBe(0.5);
  });
});

describe('rankCandidates / capPerRepo', () => {
  it('orders by score, then repository and PR number, and caps each repository', () => {
    const ranked = rankCandidates([
      candidate('b/shop', 2, 0.5),
      candidate('a/blog', 9, 0.9),
      candidate('b/shop', 1, 0.5),
      candidate('a/blog', 3, 0.5),
      candidate('a/blog', 4, 0.4),
    ]);

    expect(ranked.map((c) => c.id)).toEqual([
      'a-blog-9',
      'a-blog-3',
      'b-shop-1',
      'b-shop-2',
      'a-blog-4',
    ]);
    expect(capPerRepo(ranked, 1).map((c) => c.id)).toEqual(['a-blog-9', 'b-shop-1']);
  });
});

describe('candidatesMarkdown', () => {
  it('lists totals and one escaped row per candidate', () => {
    const markdown = candidatesMarkdown({
      generatedAt: '2026-10-09T00:00:00.000Z',
      since: '2026-04-09',
      repos: 1,
      candidates: [
        {
          ...candidate('a/blog', 9, 0.9),
          validation: { status: 'failed', code: 'SETUP_UNSUPPORTED', message: 'x' },
        },
      ],
    });

    expect(markdown).toContain('1 merged PRs since 2026-04-09 across 1 repositories');
    expect(markdown).toContain('- Type: ui 1');
    expect(markdown).toContain(
      '| 1 | 0.90 | a/blog (★1000) | [#9 PR 9 \\| with a pipe](https://github.com/a/blog/pull/9) | ui | easy | octocat | 1 | app router, no db, .env.example | SETUP_UNSUPPORTED |',
    );
  });
});
