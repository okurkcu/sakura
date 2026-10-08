import { BdiffError } from '@bdiff/core';
import { createTestLogger, FakeExec } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import { resolveToolVersion } from './tool-version.js';

const signal = new AbortController().signal;
const sha = 'a'.repeat(40);

function resolve(exec: FakeExec, env: Record<string, string> = {}) {
  const logger = createTestLogger();
  return { version: resolveToolVersion({ env, exec, cwd: '/bdiff', signal, logger }), logger };
}

describe('resolveToolVersion', () => {
  it.each([
    { env: { BDIFF_TOOL_VERSION: 'v-explicit' }, expected: 'v-explicit' },
    { env: { GITHUB_SHA: 'b'.repeat(40) }, expected: 'b'.repeat(40) },
    { env: { BDIFF_TOOL_VERSION: 'first', GITHUB_SHA: 'second' }, expected: 'first' },
  ])('uses $expected from the environment without running git', async ({ env, expected }) => {
    const exec = new FakeExec();

    expect(await resolve(exec, env).version).toBe(expected);
    expect(exec.calls).toEqual([]);
  });

  it('uses the git SHA of a clean checkout', async () => {
    const exec = new FakeExec()
      .on({ cmd: 'git', args: ['rev-parse', 'HEAD'] }, { stdout: `${sha}\n` })
      .on({ cmd: 'git', args: ['status', '--porcelain'] }, { stdout: '' });

    expect(await resolve(exec).version).toBe(sha);
    expect(exec.calls[0]?.options.cwd).toBe('/bdiff');
  });

  it('marks a checkout with uncommitted changes as dirty', async () => {
    const exec = new FakeExec()
      .on({ cmd: 'git', args: ['rev-parse', 'HEAD'] }, { stdout: sha })
      .on({ cmd: 'git', args: ['status', '--porcelain'] }, { stdout: ' M package.json\n' });

    expect(await resolve(exec).version).toBe(`${sha}-dirty`);
  });

  it('falls back to "unknown" with a warning when git fails', async () => {
    const exec = new FakeExec().on(
      { cmd: 'git' },
      { exitCode: 128, stderr: 'not a git repository' },
    );
    const { version, logger } = resolve(exec);

    expect(await version).toBe('unknown');
    expect(logger.entries.map((entry) => entry.level)).toEqual(['warn']);
  });

  it('falls back to "unknown" with a warning when git is not installed', async () => {
    const exec = new FakeExec().on(
      { cmd: 'git' },
      { error: new BdiffError('EXEC_FAILED', 'no git') },
    );
    const { version, logger } = resolve(exec);

    expect(await version).toBe('unknown');
    expect(logger.entries).toHaveLength(1);
  });
});
