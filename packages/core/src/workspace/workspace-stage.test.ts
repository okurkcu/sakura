import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceStage } from './workspace-stage.js';
import type { Exec } from '../adapters/exec.js';
import { createExecaExec } from '../adapters/execa-exec.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import type { Target } from '../domain/target.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { createTestStageContext } from '../testing/stage-context.js';

const realExec = createExecaExec();
const signal = new AbortController().signal;

/** Records every exec call so tests can see which git commands ran. */
function recordingExec(): Exec & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd, args, options) => {
      calls.push([cmd, ...args]);
      return realExec.run(cmd, args, options);
    },
  };
}

/** Runs git in `cwd` with a fixed identity and no user config; returns stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await realExec.run('git', args, {
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
    timeoutMs: 30_000,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new BdiffError('GIT_FAILED', `git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function commitFile(repo: string, file: string, content: string, message: string) {
  await nodeFileSystem.mkdir(path.dirname(path.join(repo, file)));
  await writeFile(path.join(repo, file), content);
  await git(repo, 'add', '--all');
  await git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('createWorkspaceStage (real git)', () => {
  let root: string;
  let source: string;
  let cacheDir: string;
  let outDir: string;

  const target = (overrides: Partial<Target> = {}): Target => ({
    repoUrl: source,
    baseRef: 'main',
    headRef: 'feature',
    ...overrides,
  });

  const runStage = async (t: Target, exec: Exec = realExec) => {
    const test = createTestStageContext({ outDir });
    const stage = createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir, cwd: root });
    try {
      return { test, workspace: await stage.run(t, test.ctx) };
    } catch (error) {
      await test.runCleanups();
      throw error;
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-ws-'));
    source = path.join(root, 'source');
    cacheDir = path.join(root, 'cache');
    outDir = path.join(root, 'out');
    await nodeFileSystem.mkdir(source);
    await git(source, 'init', '--quiet', '--initial-branch', 'main');
    await commitFile(source, 'app/page.tsx', 'export default 1;\n', 'init');
    await commitFile(source, 'lib/orders.ts', 'export const order = 1;\n'.repeat(20), 'lib');
    await git(source, 'checkout', '--quiet', '-b', 'feature');
    await git(source, 'mv', 'lib/orders.ts', 'lib/order repository.ts');
    await commitFile(source, 'app/page.tsx', 'export default 2;\n', 'feature');
    await git(source, 'checkout', '--quiet', 'main');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('checks out base and head and lists changes with renames', async () => {
    const { test, workspace } = await runStage(target());

    expect(workspace.baseSha).toBe(await git(source, 'rev-parse', 'main'));
    expect(workspace.headSha).toBe(await git(source, 'rev-parse', 'feature'));
    expect(workspace.changedFiles).toEqual([
      { status: 'modified', path: 'app/page.tsx' },
      { status: 'renamed', path: 'lib/order repository.ts', oldPath: 'lib/orders.ts' },
    ]);
    expect(await readFile(path.join(workspace.basePath, 'app/page.tsx'), 'utf8')).toBe(
      'export default 1;\n',
    );
    expect(await readFile(path.join(workspace.headPath, 'app/page.tsx'), 'utf8')).toBe(
      'export default 2;\n',
    );
    expect(workspace.basePath).toBe(test.ctx.paths.worktree('base'));
    expect(test.logger.entries.map((entry) => entry.message)).toContain('repo cloned');
    await test.runCleanups();
  });

  it('uses the merge-base, not the moved-on base branch tip', async () => {
    const forkPoint = await git(source, 'rev-parse', 'main');
    await commitFile(source, 'README.md', 'later on main\n', 'main moves on');

    const { test, workspace } = await runStage(target());

    expect(workspace.baseSha).toBe(forkPoint);
    expect(workspace.changedFiles.map((file) => file.path)).not.toContain('README.md');
    await test.runCleanups();
  });

  it('reuses the cache on the next run: fetches, never clones again', async () => {
    const first = await runStage(target());
    await first.test.runCleanups();
    await git(source, 'checkout', '--quiet', 'feature');
    const newHead = await commitFile(source, 'app/extra.ts', 'x\n', 'more');
    await git(source, 'checkout', '--quiet', 'main');
    const exec = recordingExec();

    const second = await runStage(target(), exec);

    const subcommands = exec.calls.map((call) =>
      call.find((arg) => ['clone', 'fetch'].includes(arg)),
    );
    expect(subcommands).toContain('fetch');
    expect(subcommands).not.toContain('clone');
    expect(second.test.logger.entries.map((entry) => entry.message)).toContain('repo cache hit');
    expect(second.workspace.headSha).toBe(newHead);
    await second.test.runCleanups();
  });

  it('reclones a broken cache', async () => {
    const first = await runStage(target());
    await first.test.runCleanups();
    const [cached] = await nodeFileSystem.readdir(path.join(cacheDir, 'repos'));
    await rm(path.join(cacheDir, 'repos', cached ?? '', 'HEAD'));

    const second = await runStage(target());

    expect(second.test.logger.entries.map((entry) => entry.message)).toContain('repo cloned');
    await second.test.runCleanups();
  });

  it('removes both worktrees and their git registrations in cleanup', async () => {
    const { test, workspace } = await runStage(target());
    const [cached] = await nodeFileSystem.readdir(path.join(cacheDir, 'repos'));
    const cache = path.join(cacheDir, 'repos', cached ?? '');

    expect(test.cleanups.map((cleanup) => cleanup.name)).toEqual([
      'worktree base',
      'worktree head',
    ]);
    await test.runCleanups();

    expect(await nodeFileSystem.exists(workspace.basePath)).toBe(false);
    expect(await nodeFileSystem.exists(workspace.headPath)).toBe(false);
    expect((await git(cache, 'worktree', 'list')).split('\n')).toHaveLength(1);
    expect(await nodeFileSystem.exists(path.dirname(workspace.basePath))).toBe(false);
  });

  it('falls back to refs/pull/<n>/head for a head that is not a branch (fork PRs)', async () => {
    const forkSha = await git(source, 'rev-parse', 'feature');
    await git(source, 'update-ref', 'refs/pull/7/head', forkSha);
    await git(source, 'branch', '--quiet', '-D', 'feature');

    const { test, workspace } = await runStage(
      target({ headRef: 'contributor:feature', prNumber: 7 }),
    );

    expect(workspace.headSha).toBe(forkSha);
    await test.runCleanups();
  });

  it.each([
    { name: 'an unknown head', overrides: { headRef: 'nope' }, code: 'REF_NOT_FOUND' },
    { name: 'an unknown base', overrides: { baseRef: 'nope' }, code: 'REF_NOT_FOUND' },
    {
      name: 'an unknown PR head',
      overrides: { headRef: 'nope', prNumber: 9 },
      code: 'REF_NOT_FOUND',
    },
    {
      name: 'a missing local repository',
      overrides: { repoUrl: '/does/not/exist' },
      code: 'REPO_UNSUPPORTED',
    },
    {
      name: 'an ssh URL',
      overrides: { repoUrl: 'git@github.com:acme/shop.git' },
      code: 'REPO_UNSUPPORTED',
    },
  ])('fails with $code for $name', async ({ overrides, code }) => {
    await expect(runStage(target(overrides))).rejects.toMatchObject({ code });
  });

  it('fails with NO_MERGE_BASE for unrelated histories, after cleaning nothing up', async () => {
    await git(source, 'checkout', '--quiet', '--orphan', 'unrelated');
    await commitFile(source, 'other.txt', 'x\n', 'orphan');
    await git(source, 'checkout', '--quiet', 'main');

    await expect(runStage(target({ headRef: 'unrelated' }))).rejects.toMatchObject({
      code: 'NO_MERGE_BASE',
    });
  });

  it('does not run user git hooks', async () => {
    const hooks = path.join(root, 'hooks');
    await nodeFileSystem.mkdir(hooks);
    const marker = path.join(root, 'hook-ran');
    await writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    const previous = process.env.GIT_CONFIG_PARAMETERS;
    process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${hooks}'`;
    try {
      const { test } = await runStage(target());
      await test.runCleanups();
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_CONFIG_PARAMETERS;
      } else {
        process.env.GIT_CONFIG_PARAMETERS = previous;
      }
    }

    expect(await nodeFileSystem.exists(marker)).toBe(false);
  });
});
