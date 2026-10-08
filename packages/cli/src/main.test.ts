import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const mainScript = path.join(repoRoot, 'packages/cli/src/main.ts');
const interruptibleScript = path.join(repoRoot, 'packages/cli/test/interruptible-run.ts');
const runArgs = [
  'run',
  '--repo',
  'https://github.com/acme/shop.git',
  '--base',
  'main',
  '--head',
  'pr/1',
];

interface Spawned {
  readonly exitCode: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly kill: (signal: NodeJS.Signals) => void;
}

/** Runs a TypeScript entry point in a real Node process, the way `pnpm bdiff` does. */
function spawnTs(script: string, args: readonly string[]): Spawned {
  const child = spawn(
    process.execPath,
    ['--conditions=bdiff-source', '--import', 'tsx', script, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, BDIFF_TOOL_VERSION: 'test-version', BDIFF_LOG_LEVEL: 'warn' },
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

describe('bdiff binary', () => {
  let out: string;

  beforeEach(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'bdiff-bin-'));
  });

  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('runs with stub stages and exits 0', async () => {
    const run = spawnTs(mainScript, [...runArgs, '--out', out]);

    expect(await run.exitCode).toBe(0);
    expect(run.stdout()).toContain('bdiff: success');
    expect(await readdir(out)).toEqual(['results.csv', 'runs']);
  });

  it('exits 2 on invalid usage', async () => {
    const run = spawnTs(mainScript, ['run', '--repo', 'x']);

    expect(await run.exitCode).toBe(2);
    expect(run.stderr()).toContain("required option '--base <ref>' not specified");
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'on a real %s cleans up, records the run and exits 130',
    async (signal) => {
      const run = spawnTs(interruptibleScript, [...runArgs, '--out', out]);
      await waitForOutput(run, 'READY');

      run.kill(signal);

      expect(await run.exitCode).toBe(130);
      expect(run.stdout()).toMatch(/CLEANED containers\n[\s\S]*CLEANED worktrees\n/);
      expect(run.stdout()).toContain('failed at environment (ABORTED)');
      expect(await readdir(out)).toEqual(['results.csv', 'runs']);
    },
  );
});
