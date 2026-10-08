import { describe, expect, it } from 'vitest';

import { abortError, throwIfAborted } from './abort.js';
import { BdiffError, isBdiffError } from './bdiff-error.js';
import { FailureRecordSchema, toFailureRecord } from './failure-record.js';

describe('BdiffError', () => {
  it('carries code, stage, details and the standard cause', () => {
    const cause = new Error('disk full');
    const error = new BdiffError('SETUP_BUILD_FAILED', 'next build failed', {
      stage: 'environment',
      cause,
      details: { side: 'head', exitCode: 1 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(isBdiffError(error)).toBe(true);
    expect(error.name).toBe('BdiffError');
    expect(error.code).toBe('SETUP_BUILD_FAILED');
    expect(error.stage).toBe('environment');
    expect(error.details).toEqual({ side: 'head', exitCode: 1 });
    expect(error.cause).toBe(cause);
  });

  it('defaults to no stage, empty details and no cause', () => {
    const error = new BdiffError('INTERNAL', 'boom');

    expect(error.stage).toBeUndefined();
    expect(error.details).toEqual({});
    expect('cause' in error).toBe(false);
  });

  it('is not confused with other errors', () => {
    expect(isBdiffError(new Error('x'))).toBe(false);
    expect(isBdiffError({ code: 'INTERNAL' })).toBe(false);
  });
});

describe('toFailureRecord', () => {
  it.each([
    {
      name: 'BdiffError with its own stage',
      error: new BdiffError('PROBE_TIMEOUT', 'route timed out', {
        stage: 'probe-ui',
        details: { route: '/login' },
      }),
      stage: 'diff' as const,
      expected: {
        code: 'PROBE_TIMEOUT',
        stage: 'probe-ui',
        message: 'route timed out',
        details: { route: '/login' },
        causes: [],
      },
    },
    {
      name: 'BdiffError without a stage takes the fallback',
      error: new BdiffError('EXEC_TIMEOUT', 'git timed out'),
      stage: 'workspace' as const,
      expected: {
        code: 'EXEC_TIMEOUT',
        stage: 'workspace',
        message: 'git timed out',
        details: {},
        causes: [],
      },
    },
    {
      name: 'plain Error becomes INTERNAL',
      error: new TypeError('x is not a function'),
      stage: 'recipe' as const,
      expected: {
        code: 'INTERNAL',
        stage: 'recipe',
        message: 'TypeError: x is not a function',
        details: {},
        causes: [],
      },
    },
    {
      name: 'thrown string',
      error: 'something bad',
      stage: undefined,
      expected: { code: 'INTERNAL', message: 'something bad', details: {}, causes: [] },
    },
    {
      name: 'thrown object',
      error: { reason: 'nope' },
      stage: undefined,
      expected: { code: 'INTERNAL', message: '{"reason":"nope"}', details: {}, causes: [] },
    },
    {
      name: 'thrown undefined',
      error: undefined,
      stage: undefined,
      expected: { code: 'INTERNAL', message: 'undefined', details: {}, causes: [] },
    },
  ])('maps $name', ({ error, stage, expected }) => {
    expect(toFailureRecord(error, stage)).toEqual(expected);
  });

  it('records the cause chain', () => {
    const root = new Error('ECONNRESET');
    const middle = new Error('fetch failed', { cause: root });
    const error = new BdiffError('INTERNAL', 'run failed', { cause: middle });

    expect(toFailureRecord(error).causes).toEqual([
      { name: 'Error', message: 'fetch failed' },
      { name: 'Error', message: 'ECONNRESET' },
    ]);
  });

  it('records a non-Error cause and stops', () => {
    const error = new BdiffError('INTERNAL', 'run failed', { cause: 'timeout' });

    expect(toFailureRecord(error).causes).toEqual([{ name: 'string', message: 'timeout' }]);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });

    expect(toFailureRecord(new BdiffError('INTERNAL', 'x', { cause: a })).causes).toHaveLength(10);
  });

  it('describes unserializable thrown values without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(toFailureRecord(circular).message).toBe('[object Object]');
    expect(toFailureRecord(10n).message).toBe('[object BigInt]');
  });

  it('produces records that survive JSON and validate against the schema', () => {
    const record = toFailureRecord(
      new BdiffError('SETUP_MISSING_ENV', 'DATABASE_URL is required', {
        stage: 'recipe',
        cause: new Error('not in .env.example'),
        details: { keys: ['DATABASE_URL'], optional: null },
      }),
    );
    const roundTripped: unknown = JSON.parse(JSON.stringify(record));

    expect(roundTripped).toEqual(record);
    expect(FailureRecordSchema.parse(roundTripped)).toEqual(record);
  });
});

describe('abort helpers', () => {
  it('wraps a non-bdiff abort reason as ABORTED', () => {
    const controller = new AbortController();
    controller.abort('user pressed Ctrl+C');
    const error = abortError(controller.signal);

    expect(error.code).toBe('ABORTED');
    expect(error.cause).toBe('user pressed Ctrl+C');
  });

  it('returns a BdiffError reason unchanged', () => {
    const reason = new BdiffError('BUDGET_EXCEEDED', 'over budget');
    const controller = new AbortController();
    controller.abort(reason);

    expect(abortError(controller.signal)).toBe(reason);
  });

  it('throwIfAborted throws only after abort', () => {
    const controller = new AbortController();

    expect(() => {
      throwIfAborted(controller.signal);
    }).not.toThrow();
    controller.abort();
    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(BdiffError);
  });
});
