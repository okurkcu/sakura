import type { RunEvent, Side } from '@bdiff/core';

/** One bar of the timeline, in ms from the start of the run. */
export interface TimelineBar {
  readonly start: number;
  readonly end: number;
  readonly state: 'done' | 'running' | 'failed' | 'skipped';
}

/** One row of the timeline: a stage, or one side of the environment. */
export interface TimelineLane {
  readonly name: string;
  /** Environment sides are drawn under the environment stage, indented. */
  readonly side?: Side;
  readonly bars: readonly TimelineBar[];
  /** Total time of its bars. */
  readonly totalMs: number;
}

/** The whole timeline. */
export interface Timeline {
  readonly lanes: readonly TimelineLane[];
  /** Time from the run's start to its end (or now). */
  readonly spanMs: number;
  /** Axis labels, in ms. */
  readonly ticks: readonly number[];
}

/**
 * A Gantt chart of the run from its events: one lane per stage in the order stages first started
 * (each execution a bar, so a repaired setup shows its attempts), plus the base and head
 * environment sides as two lanes under `environment`. A stage still running ends `now`; a skipped
 * one is a zero-length bar. `finishedAt` (from the run's record) ends a run whose events stop
 * before `run-finished`. Pure.
 */
export function buildTimeline(
  events: readonly RunEvent[],
  now: number,
  finishedAt?: number,
): Timeline {
  const first = events[0];
  if (first === undefined) {
    return { lanes: [], spanMs: 0, ticks: [] };
  }
  const origin = Date.parse(first.at);
  const at = (event: RunEvent) => Date.parse(event.at) - origin;
  const finished = events.find((event) => event.type === 'run-finished');
  const endMs =
    finished !== undefined
      ? at(finished)
      : finishedAt !== undefined
        ? finishedAt - origin
        : undefined;
  const spanMs = Math.max(1, endMs ?? now - origin);

  const lanes = new Map<string, { side?: Side; bars: TimelineBar[] }>();
  const open = new Map<string, number>();
  const lane = (name: string, side?: Side) => {
    let found = lanes.get(name);
    if (found === undefined) {
      found = side === undefined ? { bars: [] } : { side, bars: [] };
      lanes.set(name, found);
    }
    return found;
  };
  const close = (name: string, end: number, state: TimelineBar['state']) => {
    const start = open.get(name);
    if (start !== undefined) {
      lane(name).bars.push({ start, end, state });
      open.delete(name);
    }
  };

  for (const event of events) {
    switch (event.type) {
      case 'stage-started':
        lane(event.stage);
        open.set(event.stage, at(event));
        break;
      case 'stage-finished':
        if (event.status === 'skipped') {
          lane(event.stage).bars.push({ start: at(event), end: at(event), state: 'skipped' });
        } else {
          close(event.stage, at(event), 'done');
        }
        break;
      case 'stage-failed':
        close(event.stage, at(event), 'failed');
        break;
      case 'environment-side': {
        const name = `environment · ${event.side}`;
        lane(name, event.side);
        if (event.status === 'started') {
          open.set(name, at(event));
        } else {
          close(name, at(event), event.status === 'ready' ? 'done' : 'failed');
        }
        break;
      }
      default:
        break;
    }
  }
  for (const [name, start] of open) {
    lane(name).bars.push({ start, end: spanMs, state: endMs === undefined ? 'running' : 'failed' });
  }

  // Environment sides go right under the environment stage.
  const names = [...lanes.keys()].filter((name) => !name.startsWith('environment · '));
  const ordered = names.flatMap((name) =>
    name === 'environment'
      ? [name, ...[...lanes.keys()].filter((key) => key.startsWith('environment · '))]
      : [name],
  );
  for (const name of lanes.keys()) {
    if (!ordered.includes(name)) {
      ordered.push(name);
    }
  }
  return {
    lanes: ordered.map((name) => {
      const found = lane(name);
      return {
        name,
        ...(found.side === undefined ? {} : { side: found.side }),
        bars: found.bars,
        totalMs: found.bars.reduce((sum, bar) => sum + (bar.end - bar.start), 0),
      };
    }),
    spanMs,
    ticks: ticksFor(spanMs),
  };
}

/** Four to six round axis labels from 0 to `spanMs`. Pure. */
export function ticksFor(spanMs: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
  const step = steps.find((candidate) => spanMs / candidate <= 5) ?? 3_600_000;
  const ticks: number[] = [];
  for (let tick = 0; tick <= spanMs; tick += step) {
    ticks.push(tick);
  }
  return ticks;
}
