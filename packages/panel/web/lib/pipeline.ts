import type { ProbeRun, RunEvent, StageName, StageTiming } from '@bdiff/core';

import { PANEL_STAGES } from '../../src/stages.js';

/**
 * How far a stage got: `done`, running now (`current`), not reached yet (`pending`), left out by
 * the LLM mode (`skipped`), `failed`, or never needed because the run went past it (`unused`,
 * e.g. setup repair after a setup that worked).
 */
export type StageState = 'done' | 'current' | 'pending' | 'skipped' | 'failed' | 'unused';

/** One stage of the pipeline strip. */
export interface StageCell {
  readonly stage: StageName;
  readonly state: StageState;
  /** Time spent in it so far (all its executions). */
  readonly durationMs?: number;
}

/**
 * The pipeline strip of a run, from its events, else (records written before events existed) from
 * its stage timings. `ended`: the run is over, so nothing is pending any more. Pure.
 */
export function pipelineStrip(
  events: readonly RunEvent[],
  timings: readonly StageTiming[] | undefined,
  ended: boolean,
  now: number,
): StageCell[] {
  const cells = new Map<StageName, { state: StageState; durationMs: number; startedAt?: number }>();
  if (events.length > 0) {
    for (const event of events) {
      if (event.type === 'stage-started') {
        const cell = cells.get(event.stage) ?? { state: 'current', durationMs: 0 };
        cells.set(event.stage, { ...cell, state: 'current', startedAt: Date.parse(event.at) });
      } else if (event.type === 'stage-finished' || event.type === 'stage-failed') {
        const cell = cells.get(event.stage) ?? { state: 'done', durationMs: 0 };
        cells.set(event.stage, {
          state:
            event.type === 'stage-failed'
              ? 'failed'
              : event.status === 'skipped'
                ? 'skipped'
                : 'done',
          durationMs: cell.durationMs + event.durationMs,
        });
      }
    }
  } else {
    for (const timing of timings ?? []) {
      const cell = cells.get(timing.stage);
      cells.set(timing.stage, {
        state:
          timing.outcome === 'failed'
            ? 'failed'
            : timing.outcome === 'skipped'
              ? 'skipped'
              : 'done',
        durationMs: (cell?.durationMs ?? 0) + timing.durationMs,
      });
    }
  }
  const reached = PANEL_STAGES.map((stage) => cells.has(stage));
  const lastReached = reached.lastIndexOf(true);
  return PANEL_STAGES.map((stage, index) => {
    const cell = cells.get(stage);
    if (cell === undefined) {
      return { stage, state: ended || index < lastReached ? 'unused' : 'pending' };
    }
    if (cell.state === 'current') {
      const running = ended ? 0 : now - (cell.startedAt ?? now);
      return { stage, state: ended ? 'failed' : 'current', durationMs: cell.durationMs + running };
    }
    return { stage, state: cell.state, durationMs: cell.durationMs };
  });
}

/** Pages captured so far per probe run, out of how many. */
export interface CaptureProgress {
  readonly probeRun: ProbeRun;
  readonly done: number;
  readonly total: number;
  readonly failed: number;
}

/** Capture progress of each probe run, from `capture` events; empty before the UI probe. Pure. */
export function captureProgress(events: readonly RunEvent[]): CaptureProgress[] {
  const runs: ProbeRun[] = ['baseA', 'baseB', 'head'];
  const captures = events.filter((event) => event.type === 'capture');
  if (captures.length === 0) {
    return [];
  }
  const total = Math.max(...captures.map((event) => event.total));
  return runs.map((probeRun) => {
    const mine = captures.filter((event) => event.probeRun === probeRun);
    return {
      probeRun,
      done: mine.length,
      total,
      failed: mine.filter((event) => event.status === 'error').length,
    };
  });
}

/** The last `count` log lines of the events. Pure. */
export function logTail(
  events: readonly RunEvent[],
  count: number,
): Extract<RunEvent, { type: 'log' }>[] {
  return events.filter((event) => event.type === 'log').slice(-count);
}
