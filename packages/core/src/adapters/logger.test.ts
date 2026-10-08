import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import type { LoggerOptions } from './logger.js';

function capture(level: LoggerOptions['level'] = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes structured JSON lines with message, level and ISO time', () => {
    const { logger, lines } = capture();

    logger.info('worktree created', { side: 'head' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, msg: 'worktree created', side: 'head' });
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('adds child bindings, e.g. the stage, to every line', () => {
    const { logger, lines } = capture();

    logger.child({ runId: 'r1' }).child({ stage: 'recipe' }).warn('no lockfile');

    expect(lines[0]).toMatchObject({ runId: 'r1', stage: 'recipe', msg: 'no lockfile' });
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture('info');

    logger.debug('noisy');
    logger.error('important');

    expect(lines.map((line) => line.msg)).toEqual(['important']);
  });

  it('redacts secrets at the top level and nested', () => {
    const { logger, lines } = capture();

    logger.info('calling api', {
      apiKey: 'sk-1',
      env: { GITHUB_TOKEN: 'ghp-2', PATH: '/bin' },
      request: { headers: { authorization: 'Bearer 3' } },
    });
    const output = JSON.stringify(lines[0]);

    expect(output).not.toMatch(/sk-1|ghp-2|Bearer 3/);
    expect(lines[0]).toMatchObject({
      apiKey: '[REDACTED]',
      env: { GITHUB_TOKEN: '[REDACTED]', PATH: '/bin' },
      request: { headers: { authorization: '[REDACTED]' } },
    });
  });
});
