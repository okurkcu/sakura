import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { nodeFileSystem } from '@bdiff/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_BRANCH, PR_BRANCHES } from './branches.js';
import { buildFixtureRepo } from './build-fixture-repo.js';
import { loadExpected } from './expected-schema.js';
import type { Expected } from './expected-schema.js';
import { buildTempFixtureRepo, exec, git, parseNameStatus } from './test-helpers.js';

describe('buildFixtureRepo', () => {
  let repo: Awaited<ReturnType<typeof buildTempFixtureRepo>>;
  let expected: Expected;

  beforeAll(async () => {
    repo = await buildTempFixtureRepo();
    expected = await loadExpected(nodeFileSystem);
  });

  afterAll(async () => {
    await repo.remove();
  });

  it('creates main and every PR branch, leaving main checked out and clean', async () => {
    const branches = (await git(repo.path, ['branch', '--format=%(refname:short)'])).split('\n');

    expect(branches.sort()).toEqual([BASE_BRANCH, ...PR_BRANCHES].sort());
    expect(await git(repo.path, ['branch', '--show-current'])).toBe(BASE_BRANCH);
    expect(await git(repo.path, ['status', '--porcelain'])).toBe('');
  });

  it('gives every PR branch exactly one commit on top of main', async () => {
    for (const branch of PR_BRANCHES) {
      expect(await git(repo.path, ['rev-list', '--count', `${BASE_BRANCH}..${branch}`])).toBe('1');
      expect(await git(repo.path, ['merge-base', BASE_BRANCH, branch])).toBe(repo.commits.main);
    }
  });

  it.each(PR_BRANCHES)('changes exactly the expected files on %s', async (branch) => {
    const diff = await git(repo.path, ['diff', '--name-status', '-M', `${BASE_BRANCH}..${branch}`]);

    expect(parseNameStatus(diff)).toEqual(
      [...expected.branches[branch].changedFiles].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it('contains the intended behavior changes', async () => {
    const show = (branch: string, file: string) => git(repo.path, ['show', `${branch}:${file}`]);

    expect(await show('main', 'app/login/page.tsx')).not.toContain('Continue with Google');
    expect(await show('pr/ui-change', 'app/login/page.tsx')).toContain('Continue with Google');
    expect(await show('pr/api-breaking', 'app/api/orders/latest/route.ts')).toMatch(
      /total: formatMoney\(.*\),\s*currency: 'USD'/s,
    );
    expect(await show('pr/refactor-no-change', 'lib/order-repository.ts')).toContain(
      'findLatestOrder',
    );
  });

  it('includes the lockfile and no build output or dependencies', async () => {
    const files = (await git(repo.path, ['ls-files'])).split('\n');

    expect(files).toContain('pnpm-lock.yaml');
    expect(
      files.some((file) => file.startsWith('node_modules/') || file.startsWith('.next/')),
    ).toBe(false);
  });

  it('commits with a fixed identity and dates', async () => {
    const log = await git(repo.path, ['log', '--all', '--format=%an <%ae>|%aI|%cI']);

    for (const line of log.split('\n')) {
      expect(line).toMatch(
        /^bdiff fixture <fixture@bdiff\.invalid>\|2026-01-01T0\d:00:00Z\|2026-01-01T0\d:00:00Z$/,
      );
    }
  });

  it('is deterministic: a second build produces identical commits', async () => {
    const second = await buildTempFixtureRepo();
    try {
      expect(second.commits).toEqual(repo.commits);
    } finally {
      await second.remove();
    }
  });

  it('refuses a non-empty target directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bdiff-fixture-nonempty-'));
    try {
      await writeFile(path.join(dir, 'keep.txt'), 'mine');

      await expect(
        buildFixtureRepo({
          targetDir: dir,
          exec,
          fs: nodeFileSystem,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
