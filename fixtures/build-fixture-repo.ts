import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BdiffError, createExecaExec, nodeFileSystem } from '@bdiff/core';
import type { Exec, FileSystem } from '@bdiff/core';

import { BASE_BRANCH, BRANCH_SPECS } from './branches.js';
import type { FixtureBranch } from './branches.js';

/** Directory holding `sample-next-app/` and `branches/`. */
const FIXTURES_DIR = import.meta.dirname;
const GIT_TIMEOUT_MS = 30_000;
/** Commit time of `main`; each PR branch is committed one hour after the previous one. */
const BASE_COMMIT_TIME = Date.parse('2026-01-01T00:00:00Z');
const IGNORED_DIRS = ['node_modules', '.next'];

/**
 * Identity and settings for every git call: a fixed author and committer, and no user or system
 * config (no signing, hooks or templates), so the same input always yields the same commit SHAs.
 */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'bdiff fixture',
  GIT_AUTHOR_EMAIL: 'fixture@bdiff.invalid',
  GIT_COMMITTER_NAME: 'bdiff fixture',
  GIT_COMMITTER_EMAIL: 'fixture@bdiff.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/** Inputs for {@link buildFixtureRepo}. */
export interface BuildFixtureRepoOptions {
  /** Where to create the repository. Must not exist or be empty. */
  readonly targetDir: string;
  readonly exec: Exec;
  readonly fs: FileSystem;
  readonly signal: AbortSignal;
  /** Fixture sources; defaults to this directory. */
  readonly sourceDir?: string;
}

/** A built fixture repository. */
export interface FixtureRepo {
  readonly path: string;
  /** Commit SHA of every branch. */
  readonly commits: Readonly<Record<FixtureBranch, string>>;
}

/**
 * Creates a git repository from the sample app: `main` holds the app, and each PR branch applies
 * its overlay on top of `main` in a single commit. Deterministic: the same sources always produce
 * the same commit SHAs. Leaves `main` checked out.
 *
 * @throws BdiffError `INVALID_INPUT` if `targetDir` is not empty, `GIT_FAILED` if a git command fails.
 */
export async function buildFixtureRepo(options: BuildFixtureRepoOptions): Promise<FixtureRepo> {
  const { targetDir, exec, fs, signal } = options;
  const sourceDir = options.sourceDir ?? FIXTURES_DIR;

  if ((await fs.exists(targetDir)) && (await fs.readdir(targetDir)).length > 0) {
    throw new BdiffError('INVALID_INPUT', `Target directory is not empty: ${targetDir}`);
  }
  await fs.mkdir(targetDir);

  const git = async (args: readonly string[], commitTime?: number): Promise<string> => {
    const env: Record<string, string> = { ...GIT_ENV };
    if (commitTime !== undefined) {
      const date = new Date(commitTime).toISOString();
      env.GIT_AUTHOR_DATE = date;
      env.GIT_COMMITTER_DATE = date;
    }
    const result = await exec.run(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
      { cwd: targetDir, env, timeoutMs: GIT_TIMEOUT_MS, signal },
    );
    if (result.exitCode !== 0) {
      throw new BdiffError('GIT_FAILED', `git ${args[0] ?? ''} failed in fixture repo`, {
        details: { args: [...args], exitCode: result.exitCode, stderr: result.stderr },
      });
    }
    return result.stdout.trim();
  };

  await git(['init', '--quiet', '--initial-branch', BASE_BRANCH]);
  await copyTree(fs, path.join(sourceDir, 'sample-next-app'), targetDir);
  await git(['add', '--all']);
  await git(['commit', '--quiet', '--message', 'Initial sample shop'], BASE_COMMIT_TIME);

  for (const [index, spec] of BRANCH_SPECS.entries()) {
    await git(['checkout', '--quiet', '-b', spec.branch, BASE_BRANCH]);
    for (const file of spec.deletes) {
      await fs.rm(path.join(targetDir, file));
    }
    await copyTree(fs, path.join(sourceDir, 'branches', spec.overlay), targetDir);
    await git(['add', '--all']);
    await git(
      ['commit', '--quiet', '--message', spec.message],
      BASE_COMMIT_TIME + (index + 1) * 3_600_000,
    );
  }
  await git(['checkout', '--quiet', BASE_BRANCH]);

  const sha = (branch: FixtureBranch) => git(['rev-parse', branch]);
  const commits: Record<FixtureBranch, string> = {
    main: await sha('main'),
    'pr/ui-change': await sha('pr/ui-change'),
    'pr/api-breaking': await sha('pr/api-breaking'),
    'pr/refactor-no-change': await sha('pr/refactor-no-change'),
    'pr/docs-only': await sha('pr/docs-only'),
  };
  return { path: targetDir, commits };
}

/** Copies every file under `from` into `to`, in sorted order, skipping build output. */
async function copyTree(fs: FileSystem, from: string, to: string): Promise<void> {
  for (const file of await fs.listFiles(from, { ignoreDirs: IGNORED_DIRS })) {
    const target = path.join(to, file);
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, await fs.readFileBytes(path.join(from, file)));
  }
}

/** CLI: `pnpm fixture:build [dir]`. Builds the repo (in a new temp dir by default) and prints its path and commits as JSON. */
async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  const targetDir = process.argv[2] ?? (await mkdtemp(path.join(tmpdir(), 'bdiff-fixture-repo-')));
  const repo = await buildFixtureRepo({
    targetDir: path.resolve(targetDir),
    exec: createExecaExec(),
    fs: nodeFileSystem,
    signal: controller.signal,
  });
  process.stdout.write(`${JSON.stringify(repo, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
