import { parseRunEvents, RunRecordSchema, RunResultSchema } from '@bdiff/core';
import type { Logger, RunEvent, RunRecord, RunResult } from '@bdiff/core';

import type { RunSource } from './run-source.js';

/** Everything the panel knows about one run, read from its directory. */
export interface LoadedRun {
  readonly runId: string;
  readonly record?: RunRecord;
  readonly result?: RunResult;
  readonly events: readonly RunEvent[];
  /** `run.json` or `result.json` exists but is not valid. */
  readonly unreadable: boolean;
}

/**
 * Reads one run: `run.json` and `events.jsonl` always, `result.json` with `withResult` (it can be
 * large). Invalid files are logged and left out, never thrown: one broken run must not hide the
 * others.
 */
export async function loadRun(
  source: RunSource,
  runId: string,
  logger: Logger,
  withResult = false,
): Promise<LoadedRun> {
  let unreadable = false;
  const parse = <T>(
    file: string,
    text: string | undefined,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): T | undefined => {
    if (text === undefined) {
      return undefined;
    }
    const parsed = schema.safeParse(parseJson(text));
    if (!parsed.success) {
      unreadable = true;
      logger.warn('run file is not valid; left out', { runId, file });
      return undefined;
    }
    return parsed.data;
  };
  const record = parse('run.json', await source.readText(runId, 'run.json'), RunRecordSchema);
  const result = withResult
    ? parse('result.json', await source.readText(runId, 'result.json'), RunResultSchema)
    : undefined;
  const events = parseRunEvents((await source.readText(runId, 'events.jsonl')) ?? '').events;
  return {
    runId,
    events,
    unreadable,
    ...(record === undefined ? {} : { record }),
    ...(result === undefined ? {} : { result }),
  };
}

/** Reads every run of `source` (without `result.json` unless asked). */
export async function loadRuns(
  source: RunSource,
  logger: Logger,
  withResult = false,
): Promise<LoadedRun[]> {
  const ids = await source.listRunIds();
  return Promise.all(ids.map((runId) => loadRun(source, runId, logger, withResult)));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON at all: the schema check below reports it like any invalid content.
    return undefined;
  }
}
