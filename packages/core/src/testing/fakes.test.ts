import { describe, expect, it } from 'vitest';

import { FAKE_CLOCK_START, FakeClock } from './fake-clock.js';
import { FakeExec } from './fake-exec.js';
import { createTestLogger } from './test-logger.js';
import { BdiffError } from '../errors/bdiff-error.js';

const signal = new AbortController().signal;

describe('FakeClock', () => {
  it('starts at a fixed time and only moves when advanced', () => {
    const clock = new FakeClock();

    expect(clock.now()).toEqual(FAKE_CLOCK_START);
    expect(clock.monotonicMs()).toBe(0);

    clock.advance(1_500);

    expect(clock.now().getTime()).toBe(FAKE_CLOCK_START.getTime() + 1_500);
    expect(clock.monotonicMs()).toBe(1_500);
  });

  it('wakes sleepers when their deadline passes, in deadline order', async () => {
    const clock = new FakeClock();
    const woken: string[] = [];
    const late = clock.sleep(300).then(() => woken.push('late'));
    const early = clock.sleep(100).then(() => woken.push('early'));

    clock.advance(99);
    await Promise.resolve();
    expect(woken).toEqual([]);
    expect(clock.pendingSleeps).toBe(2);

    clock.advance(500);
    await Promise.all([early, late]);
    expect(woken).toEqual(['early', 'late']);
    expect(clock.pendingSleeps).toBe(0);
  });

  it('resolves a zero sleep immediately', async () => {
    await expect(new FakeClock().sleep(0)).resolves.toBeUndefined();
  });

  it('rejects a sleep whose signal aborts, and forgets it', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(1_000, controller.signal);

    controller.abort();

    await expect(sleeping).rejects.toMatchObject({ code: 'ABORTED' });
    expect(clock.pendingSleeps).toBe(0);
  });

  it('rejects immediately when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(new FakeClock().sleep(10, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('sets the wall clock without moving the monotonic clock', () => {
    const clock = new FakeClock();
    clock.set(new Date('2030-05-05T00:00:00Z'));

    expect(clock.now().toISOString()).toBe('2030-05-05T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });
});

describe('FakeExec', () => {
  it('returns the first matching scripted result and records calls', async () => {
    const exec = new FakeExec()
      .on({ cmd: 'git', args: ['rev-parse', 'HEAD'] }, { stdout: 'abc\n' })
      .on({ cmd: 'git' }, { exitCode: 1, stderr: 'fatal' });

    const head = await exec.run('git', ['rev-parse', 'HEAD'], { timeoutMs: 1_000, signal });
    const other = await exec.run('git', ['status'], { timeoutMs: 1_000, signal, cwd: '/repo' });

    expect(head).toEqual({ exitCode: 0, stdout: 'abc\n', stderr: '', durationMs: 0 });
    expect(other).toMatchObject({ exitCode: 1, stderr: 'fatal' });
    expect(exec.calls.map((call) => [call.cmd, ...call.args])).toEqual([
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'status'],
    ]);
    expect(exec.calls[1]?.options.cwd).toBe('/repo');
  });

  it('supports predicate matchers and computed results', async () => {
    const exec = new FakeExec().on(
      (call) => call.args.includes('--version'),
      (call) => ({ exitCode: 0, stdout: `${call.cmd} 1.0`, stderr: '', durationMs: 5 }),
    );

    const result = await exec.run('docker', ['--version'], { timeoutMs: 1_000, signal });

    expect(result.stdout).toBe('docker 1.0');
  });

  it('simulates a timeout with the same error as the real adapter', async () => {
    const exec = new FakeExec().on({ cmd: 'sleep' }, { timeout: true });

    await expect(exec.run('sleep', ['30'], { timeoutMs: 200, signal })).rejects.toMatchObject({
      code: 'EXEC_TIMEOUT',
      details: { cmd: 'sleep', args: ['30'], timeoutMs: 200 },
    });
  });

  it('throws a scripted error', async () => {
    const failure = new BdiffError('EXEC_FAILED', 'docker not installed');
    const exec = new FakeExec().on({ cmd: 'docker' }, { error: failure });

    await expect(exec.run('docker', ['ps'], { timeoutMs: 1_000, signal })).rejects.toBe(failure);
  });

  it('throws on an unscripted call so tests cannot pass by accident', async () => {
    const exec = new FakeExec();

    await expect(exec.run('rm', ['-rf', '/'], { timeoutMs: 1_000, signal })).rejects.toThrow(
      /no response registered for: rm -rf \//,
    );
  });

  it('honours an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = new FakeExec().on({ cmd: 'git' }, {});

    await expect(
      exec.run('git', [], { timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(exec.calls).toEqual([]);
  });
});

describe('createTestLogger', () => {
  it('captures lines from the logger and its children with merged bindings', () => {
    const logger = createTestLogger();

    logger.info('start', { runId: 'r1' });
    logger.child({ stage: 'workspace' }).debug('cache hit', { repo: 'acme/app' });

    expect(logger.entries).toEqual([
      { level: 'info', message: 'start', fields: { runId: 'r1' } },
      { level: 'debug', message: 'cache hit', fields: { stage: 'workspace', repo: 'acme/app' } },
    ]);
  });
});
