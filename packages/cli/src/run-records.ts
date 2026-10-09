import path from 'node:path';

import { RunRecordSchema } from '@bdiff/core';
import type { FileSystem, Logger, RunRecord } from '@bdiff/core';

/** The run records under an output directory, and the files that could not be read. */
export interface StoredRecords {
  readonly records: RunRecord[];
  /** `run.json` files that are missing, unreadable or invalid (e.g. a run still in progress). */
  readonly unreadable: string[];
}

/**
 * Reads every `runs/<runId>/run.json` under `outDir`, oldest run first (run ids sort by time).
 * Records that cannot be read are listed, not thrown: a batch or `stats` goes on without them.
 */
export async function readRunRecords(
  fs: FileSystem,
  outDir: string,
  logger: Logger,
): Promise<StoredRecords> {
  const runsDir = path.join(outDir, 'runs');
  if (!(await fs.exists(runsDir))) {
    return { records: [], unreadable: [] };
  }
  const records: RunRecord[] = [];
  const unreadable: string[] = [];
  for (const runId of [...(await fs.readdir(runsDir))].sort()) {
    const file = path.join(runsDir, runId, 'run.json');
    try {
      records.push(RunRecordSchema.parse(JSON.parse(await fs.readFile(file))));
    } catch (error) {
      logger.warn('skipping unreadable run record', { file, err: error });
      unreadable.push(file);
    }
  }
  return { records, unreadable };
}

/** The latest record of each dataset entry, keyed by entry id. Pure. */
export function latestByEntry(records: readonly RunRecord[]): Map<string, RunRecord> {
  const latest = new Map<string, RunRecord>();
  for (const record of records) {
    if (record.dataset !== null) {
      const current = latest.get(record.dataset.id);
      if (current === undefined || current.startedAt <= record.startedAt) {
        latest.set(record.dataset.id, record);
      }
    }
  }
  return latest;
}
