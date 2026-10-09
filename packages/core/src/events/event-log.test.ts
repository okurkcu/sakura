import { describe, expect, it } from 'vitest';

import { createRunEventLog, teeLoggerToEvents } from './event-log.js';
import type { RunEventInput } from './run-event.js';
import { parseRunEvents, withoutTime } from './run-event.js';
import { FakeClock } from '../testing/fake-clock.js';
import { createMemoryFileSystem } from '../testing/memory-file-system.js';
import { createTestLogger } from '../testing/test-logger.js';

const FILE = '/out/runs/r1/events.jsonl';

function setup() {
  const fs = createMemoryFileSystem();
  const clock = new FakeClock();
  const logger = createTestLogger();
  const log = createRunEventLog({ fs, clock, logger, file: FILE });
  const written = () => parseRunEvents(String(fs.files.get(FILE) ?? ''));
  return { fs, clock, logger, log, written };
}

describe('createRunEventLog', () => {
  it('appends each event as one stamped JSON line, in order, creating the directory', async () => {
    const { log, clock, written } = setup();

    log.emit({ type: 'stage-started', stage: 'workspace' });
    clock.advance(1_500);
    log.emit({
      type: 'stage-finished',
      stage: 'workspace',
      durationMs: 1_500,
      status: 'success',
    });
    await log.flush();

    expect(written()).toEqual({
      events: [
        { type: 'stage-started', stage: 'workspace', at: '2026-01-01T00:00:00.000Z' },
        {
          type: 'stage-finished',
          stage: 'workspace',
          durationMs: 1_500,
          status: 'success',
          at: '2026-01-01T00:00:01.500Z',
        },
      ],
      invalid: 0,
    });
  });

  it('writes every event as soon as it is emitted (one append each, no buffering)', async () => {
    const { log, fs } = setup();
    const appends: string[] = [];
    const appendFile = fs.appendFile.bind(fs);
    fs.appendFile = async (file, data) => {
      appends.push(data);
      await appendFile(file, data);
    };

    log.emit({ type: 'log', level: 'info', message: 'one' });
    await log.flush();
    expect(appends).toHaveLength(1);
    log.emit({ type: 'log', level: 'info', message: 'two' });
    await log.flush();

    expect(appends).toHaveLength(2);
  });

  it('never throws when writing fails: it reports the failure once and stops writing', async () => {
    const { log, fs, logger } = setup();
    fs.failOn('appendFile');

    expect(() => {
      log.emit({ type: 'stage-started', stage: 'workspace' });
      log.emit({ type: 'stage-started', stage: 'impact' });
    }).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();

    expect(logger.entries.filter((entry) => entry.level === 'warn')).toEqual([
      expect.objectContaining({ message: 'run events could not be written; live progress stops' }),
    ]);
    expect(fs.files.has(FILE)).toBe(false);
  });
});

describe('teeLoggerToEvents', () => {
  it('sends info, warn and error lines with their stage, but neither debug lines nor fields', async () => {
    const { log, written } = setup();
    const target = createTestLogger();
    const logger = teeLoggerToEvents(target, log).child({ runId: 'r1' });
    const stageLogger = logger.child({ stage: 'probe-ui' });

    logger.debug('noise');
    logger.info('run started', { target: 'secret-free but long' });
    stageLogger.warn('page slow', { route: '/login' });
    stageLogger.error('boom');
    logger.child({ stage: 'not-a-stage' }).info('odd binding');
    await log.flush();

    const events: RunEventInput[] = written().events.map(withoutTime);
    expect(events).toEqual([
      { type: 'log', level: 'info', message: 'run started' },
      { type: 'log', level: 'warn', message: 'page slow', stage: 'probe-ui' },
      { type: 'log', level: 'error', message: 'boom', stage: 'probe-ui' },
      { type: 'log', level: 'info', message: 'odd binding' },
    ]);
    expect(target.entries.map((entry) => entry.message)).toEqual([
      'noise',
      'run started',
      'page slow',
      'boom',
      'odd binding',
    ]);
    expect(target.entries[2]?.fields).toEqual({ runId: 'r1', stage: 'probe-ui', route: '/login' });
  });
});

describe('parseRunEvents', () => {
  it('skips blank lines and counts lines that are not events, such as a half-written last one', () => {
    const line = JSON.stringify({
      type: 'stage-started',
      stage: 'diff',
      at: '2026-01-01T00:00:00.000Z',
    });

    expect(parseRunEvents(`${line}\n\n{"type":"nope"}\n${line.slice(0, 20)}`)).toEqual({
      events: [{ type: 'stage-started', stage: 'diff', at: '2026-01-01T00:00:00.000Z' }],
      invalid: 2,
    });
  });
});
