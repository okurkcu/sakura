import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BdiffError, createExecaExec, nodeFileSystem } from '@bdiff/core';
import type { ChangedFile } from '@bdiff/core';

import { buildFixtureRepo } from './build-fixture-repo.js';
import type { FixtureRepo } from './build-fixture-repo.js';

export const exec = createExecaExec();
const signal = new AbortController().signal;

/** Builds the fixture repo in a fresh temp dir. Call `remove` when done. */
export async function buildTempFixtureRepo(): Promise<
  FixtureRepo & { remove: () => Promise<void> }
> {
  const parent = await mkdtemp(path.join(tmpdir(), 'bdiff-fixture-test-'));
  const repo = await buildFixtureRepo({
    targetDir: path.join(parent, 'repo'),
    exec,
    fs: nodeFileSystem,
    signal,
  });
  return { ...repo, remove: () => rm(parent, { recursive: true, force: true }) };
}

/** Runs git in `repo` and returns trimmed stdout; throws on a non-zero exit. */
export async function git(repo: string, args: readonly string[]): Promise<string> {
  const result = await exec.run('git', args, { cwd: repo, timeoutMs: 30_000, signal });
  if (result.exitCode !== 0) {
    throw new BdiffError('GIT_FAILED', `git ${args.join(' ')} failed`, {
      details: { stderr: result.stderr },
    });
  }
  return result.stdout.trim();
}

/** Parses `git diff --name-status -M` output into changed files, sorted by path. */
export function parseNameStatus(output: string): ChangedFile[] {
  const files = output
    .split('\n')
    .filter((line) => line !== '')
    .map((line): ChangedFile => {
      const [status = '', first = '', second] = line.split('\t');
      if (status.startsWith('R') && second !== undefined) {
        return { status: 'renamed', path: second, oldPath: first };
      }
      const statuses: Record<string, ChangedFile['status']> = {
        A: 'added',
        M: 'modified',
        D: 'deleted',
      };
      const mapped = statuses[status];
      if (mapped === undefined || mapped === 'renamed') {
        throw new BdiffError('INTERNAL', `Unexpected git status line: ${line}`);
      }
      return { status: mapped, path: first };
    });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
