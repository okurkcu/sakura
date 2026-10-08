import { createArtifactPaths } from './artifact-paths.js';
import { resultsCsvHeader, toResultsCsvRow } from './results-csv.js';
import { RunRecordSchema } from './run-record.js';
import type { RunRecord } from './run-record.js';
import type { FileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Persists run records. Share one store across concurrent runs so CSV appends are serialized. */
export interface MetricsStore {
  /**
   * Validates `record` and writes it to `runs/<runId>/run.json` atomically: a temp file is written
   * and then renamed, so readers never see a partial file. Returns the path written.
   */
  writeRunRecord(record: RunRecord): Promise<string>;
  /**
   * Appends one row to `results.csv`, writing the header first if the file is new.
   *
   * @throws BdiffError `METRICS_CSV_MISMATCH` if an existing file has different columns.
   */
  appendResult(record: RunRecord): Promise<void>;
}

/** Inputs for {@link createMetricsStore}. */
export interface MetricsStoreOptions {
  readonly fs: FileSystem;
  /** Output root, `.bdiff` by default. */
  readonly rootDir: string;
}

/** Creates a {@link MetricsStore} writing under `rootDir`. */
export function createMetricsStore({ fs, rootDir }: MetricsStoreOptions): MetricsStore {
  let appendQueue: Promise<void> = Promise.resolve();

  const append = async (record: RunRecord): Promise<void> => {
    const { root, resultsCsv } = createArtifactPaths(rootDir, record.runId);
    const header = resultsCsvHeader();
    await fs.mkdir(root);
    if (await fs.exists(resultsCsv)) {
      const existingHeader = firstLine(await fs.readFile(resultsCsv));
      if (`${existingHeader}\n` !== header) {
        throw new BdiffError(
          'METRICS_CSV_MISMATCH',
          `${resultsCsv} has different columns than this bdiff version writes; move it aside`,
          { details: { path: resultsCsv, existingHeader, expectedHeader: header.trimEnd() } },
        );
      }
      await fs.appendFile(resultsCsv, toResultsCsvRow(record));
    } else {
      await fs.writeFile(resultsCsv, header + toResultsCsvRow(record));
    }
  };

  return {
    writeRunRecord: async (record) => {
      const valid = validate(record);
      const { runDir, runJson } = createArtifactPaths(rootDir, valid.runId);
      const tempPath = `${runJson}.tmp`;
      await fs.mkdir(runDir);
      try {
        await fs.writeFile(tempPath, `${JSON.stringify(valid, null, 2)}\n`);
        await fs.rename(tempPath, runJson);
      } catch (error) {
        await fs.rm(tempPath);
        throw error;
      }
      return runJson;
    },
    appendResult: (record) => {
      const valid = validate(record);
      const result = appendQueue.then(() => append(valid));
      // Keep the queue going after a failed append; the failure itself reaches the caller.
      appendQueue = result.catch(() => undefined);
      return result;
    },
  };
}

function validate(record: RunRecord): RunRecord {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new BdiffError('INTERNAL', 'Refusing to persist an invalid run record', {
      cause: parsed.error,
      details: { runId: record.runId },
    });
  }
  return parsed.data;
}

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}
