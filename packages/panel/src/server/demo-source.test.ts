import { parseRunEvents } from '@bdiff/core';
import type { RunEvent } from '@bdiff/core';
import { createMemoryFileSystem, FakeClock, TEST_TARGET } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import { createDemoRunSource, replayEvents, replayFrame } from './demo-source.js';
import { eventLines, testRecord } from '../testing/helpers.js';

const LIVE = '01k6t3y9aaaaaaaaaaaaaaaaaa';
const DONE = '01k6t3y8k0g3m5x9a2b7c4d6ef';
const T0 = '2025-06-01T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

const recorded: RunEvent[] = [
  {
    type: 'run-started',
    at: T0,
    runId: LIVE,
    target: TEST_TARGET,
    toolVersion: 'v',
    llmMode: 'fake',
    pid: 1,
  },
  { type: 'stage-started', at: at(10), stage: 'workspace' },
  { type: 'stage-finished', at: at(60), stage: 'workspace', durationMs: 50_000, status: 'success' },
  { type: 'run-finished', at: at(90), status: 'success', durationMs: 90_000 },
];

describe('replayFrame', () => {
  it('speeds a long run up to the replay length, and loops with a pause', () => {
    const frame = replayFrame(0, 50_000, 90_000, 45_000, 15_000);

    expect(frame).toEqual({ startedAt: 0, elapsedMs: 50_000, speedup: 2, lengthMs: 45_000 });
    expect(replayFrame(0, 61_000, 90_000, 45_000, 15_000)).toMatchObject({
      startedAt: 60_000,
      elapsedMs: 1_000,
    });
  });

  it('never slows a short run down', () => {
    expect(replayFrame(0, 1_000, 10_000, 45_000, 5_000)).toMatchObject({
      speedup: 1,
      lengthMs: 10_000,
    });
  });
});

describe('replayEvents', () => {
  it('shows the events whose sped-up time has come, re-stamped to the replay', () => {
    const frame = replayFrame(1_000_000, 1_000_000 + 30_000, 90_000, 45_000, 15_000);

    expect(replayEvents(recorded, frame).map((event) => [event.type, event.at])).toEqual([
      ['run-started', new Date(1_000_000).toISOString()],
      ['stage-started', new Date(1_005_000).toISOString()],
      ['stage-finished', new Date(1_030_000).toISOString()],
    ]);
  });
});

describe('createDemoRunSource', () => {
  function demo() {
    const clock = new FakeClock();
    const record = testRecord(LIVE);
    const fs = createMemoryFileSystem({
      [`/demo/runs/${DONE}/run.json`]: JSON.stringify(testRecord(DONE)),
      [`/demo/live/runs/${LIVE}/events.jsonl`]: eventLines(recorded),
      [`/demo/live/runs/${LIVE}/run.json`]: JSON.stringify(record),
      [`/demo/live/runs/${LIVE}/ui/head/a.png`]: new Uint8Array([1]),
    });
    return {
      clock,
      source: createDemoRunSource({ fs, clock, root: '/demo', replayMs: 45_000, pauseMs: 15_000 }),
    };
  }

  it('lists the finished runs and the live one', async () => {
    const { source } = demo();

    expect((await source.listRunIds()).sort()).toEqual([DONE, LIVE]);
    expect(source.root).toBe('/demo (demo)');
  });

  it('replays the live run: events grow with time, run.json appears at the end, then it starts over', async () => {
    const { source, clock } = demo();
    const events = async () =>
      parseRunEvents((await source.readText(LIVE, 'events.jsonl')) ?? '').events;

    expect(await events()).toHaveLength(1);
    expect(await source.readText(LIVE, 'run.json')).toBeUndefined();

    clock.advance(30_000);
    expect(await events()).toHaveLength(3);

    clock.advance(20_000);
    expect(await events()).toHaveLength(4);
    const record = JSON.parse((await source.readText(LIVE, 'run.json')) ?? '{}') as {
      startedAt: string;
      durationMs: number;
    };
    // The first replay started when the source was created (the fake clock's start).
    expect(record.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(record.durationMs).toBe(45_000);

    // 62 s: 2 s into the second replay (45 s replay + 15 s pause).
    clock.advance(12_000);
    expect(await events()).toHaveLength(1);
    expect(await source.readText(LIVE, 'run.json')).toBeUndefined();
  });

  it('serves the live run’s other files all the time, and treats every process as alive', async () => {
    const { source } = demo();

    expect(await source.readBytes(LIVE, 'ui/head/a.png')).toEqual(new Uint8Array([1]));
    expect(source.isAlive(123)).toBe(true);
  });
});
