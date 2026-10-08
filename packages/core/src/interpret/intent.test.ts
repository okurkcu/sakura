import { describe, expect, it } from 'vitest';

import { resolveIntent } from './intent.js';
import type { GitHubClient } from '../adapters/github.js';
import type { Target } from '../domain/target.js';
import type { Workspace } from '../domain/workspace.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { FakeExec } from '../testing/fake-exec.js';
import { createTestLogger } from '../testing/test-logger.js';
import { createGit } from '../workspace/git.js';

const signal = new AbortController().signal;
const ctx = { signal, logger: createTestLogger() };
const workspace: Workspace = {
  basePath: '/w/base',
  headPath: '/w/head',
  baseSha: 'b'.repeat(40),
  headSha: 'h'.repeat(40),
  changedFiles: [],
};
const target = (overrides: Partial<Target> = {}): Target => ({
  repoUrl: 'https://github.com/acme/shop.git',
  baseRef: 'main',
  headRef: 'pr/1',
  ...overrides,
});

function github(
  answer: { title: string; body: string } | Error,
): GitHubClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getPullRequest: (repo, number) => {
      calls.push({ repo, number });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

function gitLog(stdout: string) {
  const exec = new FakeExec().on((call) => call.cmd === 'git' && call.args.includes('log'), {
    stdout,
    exitCode: 0,
  });
  return { exec, git: createGit(exec, signal) };
}

describe('resolveIntent', () => {
  it("uses the target's own title and body first", async () => {
    const { git, exec } = gitLog('');
    const client = github({ title: 'from GitHub', body: '' });

    expect(
      await resolveIntent(
        target({ prTitle: 'Dataset title', prBody: 'Dataset body', prNumber: 1 }),
        workspace,
        { github: client, git },
        ctx,
      ),
    ).toEqual({ source: 'target', title: 'Dataset title', body: 'Dataset body', notes: [] });
    expect(client.calls).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it('reads the pull request from GitHub for a github.com repository with a PR number', async () => {
    const { git } = gitLog('');
    const client = github({ title: 'Format totals', body: 'Shows money nicely.' });

    expect(
      await resolveIntent(target({ prNumber: 42 }), workspace, { github: client, git }, ctx),
    ).toEqual({
      source: 'github',
      title: 'Format totals',
      body: 'Shows money nicely.',
      notes: [],
    });
    expect(client.calls).toEqual([{ repo: { owner: 'acme', name: 'shop' }, number: 42 }]);
  });

  it('falls back to the head commits when GitHub fails, noting why', async () => {
    const { git } = gitLog('Format the latest order total and include its currency\n\n\u001e');
    const client = github(
      new BdiffError('HTTP_FAILED', 'GitHub answered 404 for pull request #42'),
    );

    expect(
      await resolveIntent(target({ prNumber: 42 }), workspace, { github: client, git }, ctx),
    ).toEqual({
      source: 'commits',
      title: 'Format the latest order total and include its currency',
      body: '',
      notes: ['GitHub answered 404 for pull request #42'],
    });
  });

  it('reads base..head commit messages for a local repository', async () => {
    const { git, exec } = gitLog(
      'Add Google sign-in\n\nWith a new button.\n\u001e\nFix spacing\n\n\u001e',
    );

    expect(
      await resolveIntent(
        target({ repoUrl: '/repos/shop' }),
        workspace,
        { github: github(new Error('unused')), git },
        ctx,
      ),
    ).toEqual({
      source: 'commits',
      title: '2 commits',
      body: '- Add Google sign-in\n  \n  With a new button.\n- Fix spacing',
      notes: [],
    });
    expect(exec.calls[0]).toMatchObject({ options: { cwd: '/w/head' } });
    expect(exec.calls[0]?.args).toContain(`${'b'.repeat(40)}..${'h'.repeat(40)}`);
  });

  it('has no intent without commits', async () => {
    const { git } = gitLog('');

    expect(
      await resolveIntent(
        target({ repoUrl: '/repos/shop' }),
        workspace,
        { github: github(new Error('unused')), git },
        ctx,
      ),
    ).toMatchObject({
      source: 'none',
    });
  });
});
