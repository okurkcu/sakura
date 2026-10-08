import type { MetricsStore } from '../metrics/metrics-store.js';
import { RunRecordSchema } from '../metrics/run-record.js';
import type { RunRecord } from '../metrics/run-record.js';

/** A {@link MetricsStore} that keeps records in memory, validating them like the real one. */
export interface MemoryMetricsStore extends MetricsStore {
  /** Every record passed to `writeRunRecord`, in order. */
  readonly written: readonly RunRecord[];
  /** Every record passed to `appendResult`, in order. */
  readonly appended: readonly RunRecord[];
}

/** Creates a {@link MemoryMetricsStore}. */
export function createMemoryMetricsStore(): MemoryMetricsStore {
  const written: RunRecord[] = [];
  const appended: RunRecord[] = [];
  return {
    written,
    appended,
    writeRunRecord: (record) => {
      written.push(RunRecordSchema.parse(record));
      return Promise.resolve(`memory://runs/${record.runId}/run.json`);
    },
    appendResult: (record) => {
      appended.push(RunRecordSchema.parse(record));
      return Promise.resolve();
    },
  };
}
