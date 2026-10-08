import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createExecaExec } from '@bdiff/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const mainScript = path.join(repoRoot, 'packages/cli/src/main.ts');
const interruptibleScript = path.join(repoRoot, 'packages/cli/test/interruptible-run.ts');
const signal = new AbortController().signal;
const exec = createExecaExec();

/** Children still possibly running; stopped after each test so none outlives it. */
const running = new Set<{ child: ReturnType<typeof spawn>; exitCode: Promise<number | null> }>();

/** Interrupts every child still running (letting it clean up) and waits for it to exit. */
async function stopChildren(): Promise<void> {
  for (const entry of running) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill('SIGINT');
    }
    await entry.exitCode;
  }
  running.clear();
}

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
  running.add({ child, exitCode });
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
  let repo: string;
  let runArgs: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-bin-'));
    out = path.join(root, 'out');
    cache = path.join(root, 'cache');
    repo = path.join(root, 'repo');
    await mkdir(repo);
    await git(repo, 'init', '--quiet', '--initial-branch', 'main');
    await mkdir(path.join(repo, 'app'));
    await mkdir(path.join(repo, 'prisma'));
    await writeFile(path.join(repo, 'README.md'), 'base\n');
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '16.0.0' } }),
    );
    // A MySQL datasource: bdiff can't provide one, so the recipe stage records SETUP_UNSUPPORTED.
    await writeFile(
      path.join(repo, 'prisma', 'schema.prisma'),
      'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n',
    );
    await writeFile(path.join(repo, 'app', 'page.tsx'), 'export default () => "base";\n');
    await git(repo, 'add', '--all');
    await git(repo, 'commit', '--quiet', '-m', 'base');
    await git(repo, 'checkout', '--quiet', '-b', 'pr/1');
    await writeFile(path.join(repo, 'app', 'page.tsx'), 'export default () => "head";\n');
    await git(repo, 'commit', '--quiet', '-am', 'head');
    await git(repo, 'checkout', '--quiet', '-b', 'pr/docs', 'main');
    await writeFile(path.join(repo, 'README.md'), 'head\n');
    await git(repo, 'commit', '--quiet', '-am', 'docs');
    runArgs = ['run', '--repo', repo, '--base', 'main', '--head', 'pr/1'];
  });

  afterEach(async () => {
    await stopChildren();
    await rm(root, { recursive: true, force: true });
  });

  // The real stages need Docker from the environment stage on; the full successful run is covered
  // by e2e/environment-stage.docker.test.ts. Without Docker, a Next.js app whose database bdiff
  // can't provide proves the binary wires the real workspace, impact and recipe stages and records
  // the failure.
  it('runs the real workspace, impact and recipe stages and records an unsupported repository (exit 1)', async () => {
    const run = spawnTs(mainScript, [...runArgs, '--out', out], cache);

    expect(await run.exitCode, run.stderr()).toBe(1);
    expect(run.stdout()).toContain('failed at recipe (SETUP_UNSUPPORTED)');
    expect(await readdir(out)).toEqual(['results.csv', 'runs']);
    const [runId] = await readdir(path.join(out, 'runs'));
    expect(await readdir(path.join(out, 'runs', runId ?? ''))).toEqual(['run.json']);
    expect(
      JSON.parse(await readFile(path.join(out, 'runs', runId ?? '', 'run.json'), 'utf8')),
    ).toMatchObject({ failure: { stage: 'recipe', details: { provider: 'mysql' } } });
    expect(await readdir(path.join(cache, 'repos'))).toHaveLength(1);
  });

  it('skips a docs-only PR at the impact stage (exit 0)', async () => {
    const run = spawnTs(
      mainScript,
      ['run', '--repo', repo, '--base', 'main', '--head', 'pr/docs', '--out', out],
      cache,
    );

    expect(await run.exitCode, run.stderr()).toBe(0);
    expect(run.stdout()).toContain('bdiff: skipped: docs-only');
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
