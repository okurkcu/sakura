import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecOptions } from './exec.js';
import { createExecaExec } from './execa-exec.js';
import { BdiffError } from '../errors/bdiff-error.js';

const exec = createExecaExec();
const node = process.execPath;

function options(overrides: Partial<ExecOptions> = {}): ExecOptions {
  return { timeoutMs: 10_000, signal: new AbortController().signal, ...overrides };
}

/** Resolves to the rejection of `promise`, failing the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<BdiffError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the command to fail');
    },
    (reason: unknown) => reason,
  );
  if (!(error instanceof BdiffError)) {
    throw new Error(`expected a BdiffError, got: ${String(error)}`);
  }
  return error;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: the process is gone (or not ours, which a child we spawned never is).
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50 && isAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

describe('createExecaExec', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), 'bdiff-exec-')));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workDir, { recursive: true, force: true });
  });

  describe('success and failure', () => {
    it('returns exit code, stdout, stderr and duration', async () => {
      const result = await exec.run(
        node,
        ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
        options(),
      );

      expect(result).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err' });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns a non-zero exit code instead of throwing', async () => {
      const result = await exec.run(node, ['-e', 'process.exit(3)'], options());

      expect(result.exitCode).toBe(3);
    });

    it('reports death by an outside signal as 128 + signal number', async () => {
      const result = await exec.run('sh', ['-c', 'kill -9 $$'], options());

      expect(result.exitCode).toBe(137);
    });

    it('passes arguments verbatim, without a shell', async () => {
      const tricky = '$(echo pwned); `id` && "quoted" | *';
      const result = await exec.run(
        node,
        ['-e', 'process.stdout.write(process.argv[1])', tricky],
        options(),
      );

      expect(result.stdout).toBe(tricky);
    });

    it('throws EXEC_FAILED when the command does not exist', async () => {
      const error = await rejection(exec.run('bdiff-no-such-command', ['x'], options()));

      expect(error.code).toBe('EXEC_FAILED');
      expect(error.details).toMatchObject({ cmd: 'bdiff-no-such-command', args: ['x'] });
    });
  });

  describe('cwd and env', () => {
    it('runs in the given working directory', async () => {
      const result = await exec.run(
        node,
        ['-e', 'process.stdout.write(process.cwd())'],
        options({ cwd: workDir }),
      );

      expect(result.stdout).toBe(workDir);
    });

    it('merges extra env over the parent env', async () => {
      vi.stubEnv('BDIFF_TEST_INHERITED', 'from-parent');
      const result = await exec.run(
        node,
        [
          '-e',
          'process.stdout.write(`${process.env.BDIFF_TEST_INHERITED}|${process.env.BDIFF_TEST_EXTRA}`)',
        ],
        options({ env: { BDIFF_TEST_EXTRA: 'from-caller' } }),
      );

      expect(result.stdout).toBe('from-parent|from-caller');
    });

    it("does not leak bdiff's secrets to child processes", async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-secret');
      vi.stubEnv('GITHUB_TOKEN', 'ghp-test-secret');
      const result = await exec.run(
        node,
        [
          '-e',
          'process.stdout.write(`${process.env.ANTHROPIC_API_KEY}|${process.env.GITHUB_TOKEN}`)',
        ],
        options(),
      );

      expect(result.stdout).toBe('undefined|undefined');
    });

    it('passes a secret when the caller provides it explicitly', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'ghp-test-secret');
      const result = await exec.run(
        node,
        ['-e', 'process.stdout.write(String(process.env.GITHUB_TOKEN))'],
        options({ env: { GITHUB_TOKEN: 'explicit' } }),
      );

      expect(result.stdout).toBe('explicit');
    });
  });

  describe('timeout', () => {
    it('kills a sleeping child and throws EXEC_TIMEOUT', async () => {
      const startedAt = performance.now();
      const error = await rejection(exec.run('sleep', ['30'], options({ timeoutMs: 200 })));

      expect(error.code).toBe('EXEC_TIMEOUT');
      expect(error.details).toMatchObject({ cmd: 'sleep', args: ['30'], timeoutMs: 200 });
      expect(performance.now() - startedAt).toBeLessThan(5_000);
    });

    it('kills the whole process tree, including grandchildren', async () => {
      const pidFile = path.join(workDir, 'grandchild.pid');
      const script = `sleep 30 & echo $! > '${pidFile}'; wait`;

      const error = await rejection(exec.run('sh', ['-c', script], options({ timeoutMs: 500 })));
      const grandchild = Number((await readFile(pidFile, 'utf8')).trim());

      expect(error.code).toBe('EXEC_TIMEOUT');
      expect(grandchild).toBeGreaterThan(0);
      expect(await waitUntilDead(grandchild)).toBe(true);
    });

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      const ignoresTerm = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

      const error = await rejection(
        exec.run(node, ['-e', ignoresTerm], options({ timeoutMs: 200 })),
      );

      expect(error.code).toBe('EXEC_TIMEOUT');
    });

    it('keeps the tail of stderr in the error details', async () => {
      const script = "process.stderr.write('building...\\n'); setInterval(() => {}, 1000);";

      const error = await rejection(exec.run(node, ['-e', script], options({ timeoutMs: 300 })));

      expect(error.details.stderrTail).toContain('building...');
    });
  });

  describe('abort', () => {
    it('kills the child and throws ABORTED when the signal aborts', async () => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 100);

      const error = await rejection(
        exec.run('sleep', ['30'], options({ signal: controller.signal })),
      );

      expect(error.code).toBe('ABORTED');
    });

    it('rethrows a BdiffError abort reason unchanged', async () => {
      const reason = new BdiffError('BUDGET_EXCEEDED', 'run budget exhausted');
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(reason);
      }, 100);

      const error = await rejection(
        exec.run('sleep', ['30'], options({ signal: controller.signal })),
      );

      expect(error).toBe(reason);
    });

    it('does not start the command when the signal has already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      // A missing command would fail with EXEC_FAILED if it were started.
      const error = await rejection(
        exec.run('bdiff-no-such-command', [], options({ signal: controller.signal })),
      );

      expect(error.code).toBe('ABORTED');
    });
  });
});
