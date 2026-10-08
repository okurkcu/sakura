import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createExecaExec } from '@bdiff/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const mainScript = path.join(repoRoot, 'packages/cli/src/main.ts');
const interruptibleScript = path.join(repoRoot, 'packages/cli/test/interruptible-run.ts');
const signal = new AbortController().signal;
const exec = createExecaExec();

interface Spawned {
  readonly exitCode: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly kill: (signal: NodeJS.Signals) => void;
}

/** Runs a TypeScript entry point in a real Node process, the way `pnpm bdiff` does. */
function spawnTs(script: string, args: readonly string[], cacheDir = ''): Spawned {
  const child = spawn(
    process.execPath,
    ['--conditions=bdiff-source', '--import', 'tsx', script, ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        BDIFF_TOOL_VERSION: 'test-version',
        BDIFF_LOG_LEVEL: 'warn',
        BDIFF_CACHE_DIR: cacheDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return {
    exitCode,
    stdout: () => stdout,
    stderr: () => stderr,
    kill: (signal) => child.kill(signal),
  };
}

async function waitForOutput(spawned: Spawned, text: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!spawned.stdout().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${text}"; stderr: ${spawned.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Runs git with a fixed identity and no user config. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await exec.run('git', args, {
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
  expect(result.exitCode, result.stderr).toBe(0);
}

describe('bdiff binary', () => {
  let root: string;
  let out: string;
  let cache: string;
  let runArgs: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-bin-'));
    out = path.join(root, 'out');
    cache = path.join(root, 'cache');
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    await git(repo, 'init', '--quiet', '--initial-branch', 'main');
    await writeFile(path.join(repo, 'README.md'), 'base\n');
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '16.4.0' } }),
    );
    await git(repo, 'add', '--all');
    await git(repo, 'commit', '--quiet', '-m', 'base');
    await git(repo, 'checkout', '--quiet', '-b', 'pr/1');
    await writeFile(path.join(repo, 'README.md'), 'head\n');
    await git(repo, 'commit', '--quiet', '-am', 'head');
    runArgs = ['run', '--repo', repo, '--base', 'main', '--head', 'pr/1'];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs a local repository through the real workspace stage and exits 0', async () => {
    const run = spawnTs(mainScript, [...runArgs, '--out', out], cache);

    expect(await run.exitCode, run.stderr()).toBe(0);
    expect(run.stdout()).toContain('bdiff: success');
    expect(await readdir(out)).toEqual(['results.csv', 'runs']);
    const [runId] = await readdir(path.join(out, 'runs'));
    expect(await readdir(path.join(out, 'runs', runId ?? ''))).toEqual(['run.json']);
    expect(await readdir(path.join(cache, 'repos'))).toHaveLength(1);
  });

  it('exits 2 on invalid usage', async () => {
    const run = spawnTs(mainScript, ['run', '--repo', 'x']);

    expect(await run.exitCode).toBe(2);
    expect(run.stderr()).toContain("required option '--base <ref>' not specified");
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'on a real %s cleans up, records the run and exits 130',
    async (signal) => {
      const run = spawnTs(interruptibleScript, [...runArgs, '--out', out], cache);
      await waitForOutput(run, 'READY');

      run.kill(signal);

      expect(await run.exitCode).toBe(130);
      expect(run.stdout()).toMatch(/CLEANED containers\n[\s\S]*CLEANED worktrees\n/);
      expect(run.stdout()).toContain('failed at environment (ABORTED)');
      expect(await readdir(out)).toEqual(['results.csv', 'runs']);
    },
  );
});
