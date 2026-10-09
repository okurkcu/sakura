import path from 'node:path';

import { parseRunEvents, RunIdSchema } from '@bdiff/core';
import type { Clock, FileSystem, RunEvent } from '@bdiff/core';

import { createWorkspaceRunSource } from './run-source.js';
import type { RunSource } from './run-source.js';

/** Inputs of {@link createDemoRunSource}. */
export interface DemoRunSourceOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  /**
   * The demo directory: `runs/<runId>/` holds finished runs, `live/runs/<runId>/` one finished run
   * whose events are replayed as a run in progress.
   */
  readonly root: string;
  /** Longest a replay takes; a slower recorded run is sped up to fit. Default 45 s. */
  readonly replayMs?: number;
  /** Pause after a replay ends, showing the finished run, before it starts again. Default 12 s. */
  readonly pauseMs?: number;
}

/** The replay timing of the live demo run at one moment. */
export interface ReplayFrame {
  /** When the current replay started. */
  readonly startedAt: number;
  /** Time into the current replay, in replay time (ms). */
  readonly elapsedMs: number;
  /** Recorded time per replay time, ≥ 1. */
  readonly speedup: number;
  /** Replay time from the first to the last recorded event. */
  readonly lengthMs: number;
}

/**
 * Where the replay is at `now`: replays of `recordedMs / speedup` follow each other, separated by
 * `pauseMs`, from `originMs` on. Pure.
 */
export function replayFrame(
  originMs: number,
  now: number,
  recordedMs: number,
  replayMs: number,
  pauseMs: number,
): ReplayFrame {
  const speedup = Math.max(1, recordedMs / replayMs);
  const lengthMs = recordedMs / speedup;
  const cycle = lengthMs + pauseMs;
  const sinceOrigin = Math.max(0, now - originMs);
  const index = Math.floor(sinceOrigin / cycle);
  return {
    startedAt: originMs + index * cycle,
    elapsedMs: sinceOrigin - index * cycle,
    speedup,
    lengthMs,
  };
}

/**
 * The events of the live demo run visible at `frame`, re-timed to it: each recorded event shows up
 * once its (sped-up) time has come, stamped with that time. Pure.
 */
export function replayEvents(recorded: readonly RunEvent[], frame: ReplayFrame): RunEvent[] {
  const first = recorded[0];
  if (first === undefined) {
    return [];
  }
  const origin = Date.parse(first.at);
  return recorded.flatMap((event) => {
    const offset = (Date.parse(event.at) - origin) / frame.speedup;
    return offset <= frame.elapsedMs
      ? [{ ...event, at: new Date(frame.startedAt + offset).toISOString() }]
      : [];
  });
}

/**
 * The demo's runs (`bdiff ui --demo`): the finished runs of `<root>/runs`, plus the run in
 * `<root>/live/runs` replayed over and over as a run in progress. Its `run.json` and `result.json`
 * appear only once the replay reached its end; its other files (screenshots…) are always there.
 * Read-only, like the real workspace.
 */
export function createDemoRunSource(options: DemoRunSourceOptions): RunSource {
  const { fs, clock, root } = options;
  const finished = createWorkspaceRunSource({ fs, root, isAlive: () => false });
  const liveRoot = path.join(root, 'live');
  const live = createWorkspaceRunSource({
    fs,
    root: liveRoot,
    isAlive: () => true,
  });
  const origin = clock.now().getTime();
  let recorded: { runId: string; events: RunEvent[] } | null | undefined;

  const liveRun = async (): Promise<{ runId: string; events: RunEvent[] } | null> => {
    if (recorded === undefined) {
      const [runId] = await live.listRunIds();
      recorded =
        runId === undefined
          ? null
          : {
              runId,
              events: parseRunEvents((await live.readText(runId, 'events.jsonl')) ?? '').events,
            };
    }
    return recorded;
  };
  const frameOf = (events: readonly RunEvent[]): ReplayFrame => {
    const first = events[0];
    const last = events.at(-1);
    const recordedMs =
      first === undefined || last === undefined ? 0 : Date.parse(last.at) - Date.parse(first.at);
    return replayFrame(
      origin,
      clock.now().getTime(),
      Math.max(1, recordedMs),
      options.replayMs ?? 45_000,
      options.pauseMs ?? 12_000,
    );
  };

  return {
    root: `${root} (demo)`,
    listRunIds: async () => {
      const ids = await finished.listRunIds();
      const run = await liveRun();
      return run === null ? ids : [...ids, run.runId];
    },
    readText: async (runId, file) => {
      const run = await liveRun();
      if (runId !== run?.runId) {
        return finished.readText(runId, file);
      }
      const frame = frameOf(run.events);
      const done = frame.elapsedMs >= frame.lengthMs;
      if (file === 'events.jsonl') {
        return replayEvents(run.events, frame)
          .map((event) => `${JSON.stringify(event)}\n`)
          .join('');
      }
      if (file === 'run.json' || file === 'result.json') {
        const text = done ? await live.readText(runId, file) : undefined;
        return text === undefined ? undefined : retimeRecord(text, file, frame);
      }
      return live.readText(runId, file);
    },
    readBytes: async (runId, file) => {
      const run = await liveRun();
      return run !== null && runId === run.runId
        ? live.readBytes(runId, file)
        : finished.readBytes(runId, file);
    },
    listFiles: async (runId) => {
      const run = await liveRun();
      return run !== null && runId === run.runId
        ? live.listFiles(runId)
        : finished.listFiles(runId);
    },
    isAlive: () => true,
  };
}

/** The replayed run's record, re-timed to the replay that just ended. */
function retimeRecord(text: string, file: string, frame: ReplayFrame): string {
  const value = JSON.parse(text) as unknown;
  const record = (file === 'run.json' ? value : (value as { record?: unknown }).record) as
    | { startedAt?: unknown; finishedAt?: unknown; durationMs?: unknown; runId?: unknown }
    | undefined;
  if (record !== undefined && RunIdSchema.safeParse(record.runId).success) {
    record.startedAt = new Date(frame.startedAt).toISOString();
    record.finishedAt = new Date(frame.startedAt + frame.lengthMs).toISOString();
    record.durationMs = Math.round(frame.lengthMs);
  }
  return JSON.stringify(value);
}
