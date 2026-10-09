import path from 'node:path';

import { createArtifactPaths, runPipeline } from '@bdiff/core';
import type {
  Clock,
  CostCalculator,
  FileSystem,
  LlmMode,
  Logger,
  MetricsStore,
  PipelineStages,
  RunRecord,
} from '@bdiff/core';
import { renderBatchIndex } from '@bdiff/report';
import type { BatchEntry } from '@bdiff/report';

import { entryDataset, entryTarget } from './dataset.js';
import type { DatasetEntry } from './dataset.js';
import { latestByEntry } from './run-records.js';

/** How a batch treats entries that already have a record for this tool version. */
export type BatchMode = 'fresh' | 'resume' | 'force';

/** One of `count` equal parts of a batch, 1-based (`--shard index/count`). */
export interface Shard {
  readonly index: number;
  readonly count: number;
}

/**
 * The entries of one shard: every `count`-th entry starting at position `index` (round robin), so
 * shards differ in size by at most one and the split is the same on every machine. Pure.
 */
export function shardEntries<T>(entries: readonly T[], shard: Shard): T[] {
  return entries.filter((_entry, position) => position % shard.count === shard.index - 1);
}

/** Which entries a batch runs. */
export interface BatchPlan {
  readonly toRun: readonly DatasetEntry[];
  /** Entries with a finished record for this tool version, skipped by `resume`. */
  readonly done: readonly DatasetEntry[];
}

/**
 * Whether `record` finishes `entryId` for `toolVersion`: a record of that entry by that tool
 * version, whatever its status, except an interrupted (`ABORTED`) run. Pure.
 */
export function finishes(record: RunRecord, entryId: string, toolVersion: string): boolean {
  return (
    record.dataset?.id === entryId &&
    record.toolVersion === toolVersion &&
    !(record.status === 'failed' && record.failure.code === 'ABORTED')
  );
}

/**
 * Splits the selected entries into those to run and those already done (see {@link finishes}).
 * `fresh` runs everything (the caller refuses when some are done), `resume` skips the done ones,
 * `force` runs them again. Pure.
 */
export function planBatch(
  entries: readonly DatasetEntry[],
  records: readonly RunRecord[],
  toolVersion: string,
  mode: BatchMode,
): BatchPlan {
  const done = entries.filter((entry) =>
    records.some((record) => finishes(record, entry.id, toolVersion)),
  );
  const toRun = mode === 'resume' ? entries.filter((entry) => !done.includes(entry)) : entries;
  return { toRun, done };
}

/** Services a batch runs its entries with; built once by the CLI. */
export interface BatchServices {
  readonly clock: Clock;
  readonly fs: FileSystem;
  readonly logger: Logger;
  readonly costs: CostCalculator;
  readonly toolVersion: string;
  /** Shared by every run, so concurrent runs append to `results.csv` one at a time. */
  readonly store: MetricsStore;
  /** Fresh stages for one run. */
  readonly createStages: () => PipelineStages;
  /** Aborts the runs in progress; no new entry starts once it fired. */
  readonly signal: AbortSignal;
  /** Prints one progress line. */
  readonly print: (line: string) => void;
}

/** Settings of one batch. */
export interface BatchSettings {
  readonly outDir: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly budgetUsd: number;
  /** How every run uses the LLM; defaults to `on`. */
  readonly llmMode?: LlmMode;
}

/** What a batch did. */
export interface BatchOutcome {
  /** The record of every entry that ran, in completion order. */
  readonly recorded: readonly RunRecord[];
  /** Entries whose run could not be recorded (e.g. unwritable output). */
  readonly unrecorded: readonly string[];
}

/**
 * Runs entries through the pipeline, `concurrency` at a time, each one isolated: a run that fails
 * is recorded like any other, and one that cannot even be recorded is reported and skipped; the
 * batch goes on either way. Once `signal` fires, the runs in progress abort (and are recorded as
 * `ABORTED`) and no further entry starts.
 */
export async function executeBatch(
  entries: readonly DatasetEntry[],
  settings: BatchSettings,
  services: BatchServices,
): Promise<BatchOutcome> {
  const recorded: RunRecord[] = [];
  const unrecorded: string[] = [];
  const total = String(entries.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!services.signal.aborted && next < entries.length) {
      const index = next++;
      const entry = entries[index];
      if (entry === undefined) {
        return;
      }
      const label = `[${String(index + 1)}/${total}] ${entry.id}`;
      services.print(`${label}: started`);
      try {
        const { result } = await runPipeline(entryTarget(entry), services.createStages(), {
          clock: services.clock,
          fs: services.fs,
          logger: services.logger.child({ datasetEntry: entry.id }),
          costs: services.costs,
          outDir: settings.outDir,
          toolVersion: services.toolVersion,
          timeoutMs: settings.timeoutMs,
          budgetUsd: settings.budgetUsd,
          signal: services.signal,
          store: services.store,
          dataset: entryDataset(entry),
          ...(settings.llmMode === undefined ? {} : { llmMode: settings.llmMode }),
        });
        recorded.push(result.record);
        services.print(`${label}: ${outcomeLine(result.record)}`);
      } catch (error) {
        services.logger.error('batch entry could not be recorded', {
          datasetEntry: entry.id,
          err: error,
        });
        unrecorded.push(entry.id);
        services.print(
          `${label}: could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(settings.concurrency, entries.length)) }, worker),
  );
  return { recorded, unrecorded };
}

/**
 * Writes the batch index: the latest record of every entry (dataset order) that has one, linked to
 * its report when the report exists. Returns the index rows.
 */
export async function writeBatchIndex(
  fs: FileSystem,
  file: string,
  outDir: string,
  entries: readonly DatasetEntry[],
  records: readonly RunRecord[],
): Promise<BatchEntry[]> {
  const latest = latestByEntry(records);
  return writeRunsIndex(
    fs,
    file,
    outDir,
    entries.flatMap((entry) => latest.get(entry.id) ?? []),
  );
}

/**
 * Writes a batch index of `records` in the given order, each linked to its report when the report
 * exists. Returns the index rows.
 */
export async function writeRunsIndex(
  fs: FileSystem,
  file: string,
  outDir: string,
  records: readonly RunRecord[],
): Promise<BatchEntry[]> {
  const rows: BatchEntry[] = [];
  for (const record of records) {
    const report = createArtifactPaths(outDir, record.runId).reportHtml;
    rows.push(
      (await fs.exists(report))
        ? { record, reportHref: path.relative(path.dirname(file), report) }
        : { record },
    );
  }
  await renderBatchIndex(rows, file, fs);
  return rows;
}

function outcomeLine(record: RunRecord): string {
  const seconds = `${(record.durationMs / 1000).toFixed(1)}s`;
  switch (record.status) {
    case 'success':
      return `success, ${String(record.counts.findings)} findings (${seconds})`;
    case 'skipped':
      return `skipped: ${record.skip.reason}`;
    case 'failed':
      return `failed at ${record.failure.stage ?? 'startup'} (${record.failure.code}) (${seconds})`;
  }
}
