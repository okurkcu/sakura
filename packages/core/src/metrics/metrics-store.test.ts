import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifactPaths } from './artifact-paths.js';
import { createMetricsStore } from './metrics-store.js';
import { resultsCsvHeader, toResultsCsvRow } from './results-csv.js';
import { encodeUlid } from './run-id.js';
import { RunRecordSchema } from './run-record.js';
import type { RunRecord } from './run-record.js';
import type { FileSystem } from '../adapters/file-system.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { createTestRunRecorder, TEST_RUN_ID } from '../testing/run-records.js';

/** Wraps a file system and records every mutating operation, in order. */
function recordingFs(inner: FileSystem, overrides: Partial<FileSystem> = {}) {
  const operations: string[] = [];
  const fs: FileSystem = {
    ...inner,
    writeFile: (file, data) => {
      operations.push(`writeFile ${path.basename(file)}`);
      return inner.writeFile(file, data);
    },
    rename: (from, to) => {
      operations.push(`rename ${path.basename(from)} -> ${path.basename(to)}`);
      return inner.rename(from, to);
    },
    ...overrides,
  };
  return { fs, operations };
}

function successRecord(runId = TEST_RUN_ID): RunRecord {
  const { recorder } = createTestRunRecorder();
  return { ...recorder.finish({ status: 'success' }), runId };
}

describe('createMetricsStore', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = path.join(await mkdtemp(path.join(tmpdir(), 'bdiff-metrics-')), '.bdiff');
  });

  afterEach(async () => {
    await rm(path.dirname(rootDir), { recursive: true, force: true });
  });

  describe('writeRunRecord', () => {
    it('writes a failed stage as a valid run.json with failure info and partial timings', async () => {
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });
      const { recorder, clock } = createTestRunRecorder();
      await recorder.timer.measure('workspace', () => {
        clock.advance(1_200);
        return Promise.resolve();
      });
      const error = await recorder.timer
        .measure('recipe', () => {
          clock.advance(300);
          return Promise.reject(new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found'));
        })
        .catch((caught: unknown) => caught);

      const written = await store.writeRunRecord(recorder.finish({ status: 'failed', error }));
      const reread = RunRecordSchema.parse(JSON.parse(await readFile(written, 'utf8')));

      expect(written).toBe(createArtifactPaths(rootDir, TEST_RUN_ID).runJson);
      expect(reread).toMatchObject({
        status: 'failed',
        failure: { code: 'SETUP_UNSUPPORTED', stage: 'recipe', message: 'no Next.js app found' },
        stageTimings: [
          { stage: 'workspace', durationMs: 1_200, outcome: 'success' },
          { stage: 'recipe', durationMs: 300, outcome: 'failed' },
        ],
      });
    });

    it('writes to a temp file and renames it into place, leaving no temp file', async () => {
      const { fs, operations } = recordingFs(nodeFileSystem);
      const store = createMetricsStore({ fs, rootDir });

      await store.writeRunRecord(successRecord());

      expect(operations).toEqual(['writeFile run.json.tmp', 'rename run.json.tmp -> run.json']);
      expect(await readdir(createArtifactPaths(rootDir, TEST_RUN_ID).runDir)).toEqual(['run.json']);
    });

    it('replaces an existing run.json', async () => {
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });
      const first = successRecord();
      await store.writeRunRecord(first);

      const written = await store.writeRunRecord({ ...first, durationMs: 999 });

      expect(JSON.parse(await readFile(written, 'utf8'))).toMatchObject({ durationMs: 999 });
    });

    it('removes the temp file and rethrows when the rename fails', async () => {
      const renameFailure = new BdiffError('FS_FAILED', 'disk full');
      const { fs } = recordingFs(nodeFileSystem, { rename: () => Promise.reject(renameFailure) });
      const store = createMetricsStore({ fs, rootDir });

      await expect(store.writeRunRecord(successRecord())).rejects.toBe(renameFailure);
      expect(await readdir(createArtifactPaths(rootDir, TEST_RUN_ID).runDir)).toEqual([]);
    });

    it('refuses an invalid record without writing anything', async () => {
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });
      const invalid = { ...successRecord(), durationMs: -1 };

      await expect(store.writeRunRecord(invalid)).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(await nodeFileSystem.exists(rootDir)).toBe(false);
    });
  });

  describe('appendResult', () => {
    it('creates results.csv with a header when it does not exist', async () => {
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });
      const record = successRecord();

      await store.appendResult(record);

      expect(await readFile(path.join(rootDir, 'results.csv'), 'utf8')).toBe(
        resultsCsvHeader() + toResultsCsvRow(record),
      );
    });

    it('appends to an existing file without repeating the header', async () => {
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });
      const first = successRecord(encodeUlid(1, new Uint8Array(10)));
      const second = successRecord(encodeUlid(2, new Uint8Array(10)));

      await store.appendResult(first);
      await createMetricsStore({ fs: nodeFileSystem, rootDir }).appendResult(second);

      expect(await readFile(path.join(rootDir, 'results.csv'), 'utf8')).toBe(
        resultsCsvHeader() + toResultsCsvRow(first) + toResultsCsvRow(second),
      );
    });

    it('serializes concurrent appends: one header, every row once', async () => {
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });
      const records = Array.from({ length: 5 }, (_, index) =>
        successRecord(encodeUlid(index, new Uint8Array(10))),
      );

      await Promise.all(records.map((record) => store.appendResult(record)));
      const lines = (await readFile(path.join(rootDir, 'results.csv'), 'utf8'))
        .trimEnd()
        .split('\n');

      expect(lines).toHaveLength(6);
      expect(lines.filter((line) => line.startsWith('run_id,'))).toHaveLength(1);
    });

    it('refuses to append to a file with different columns', async () => {
      const csv = path.join(rootDir, 'results.csv');
      await nodeFileSystem.mkdir(rootDir);
      await writeFile(csv, 'run_id,status\nx,success\n');
      const store = createMetricsStore({ fs: nodeFileSystem, rootDir });

      await expect(store.appendResult(successRecord())).rejects.toMatchObject({
        code: 'METRICS_CSV_MISMATCH',
      });
      expect(await readFile(csv, 'utf8')).toBe('run_id,status\nx,success\n');
    });

    it('keeps appending after a failed append', async () => {
      const failing = { fails: true };
      const { fs } = recordingFs(nodeFileSystem, {
        writeFile: (file, data) =>
          failing.fails
            ? Promise.reject(new BdiffError('FS_FAILED', 'transient'))
            : nodeFileSystem.writeFile(file, data),
      });
      const store = createMetricsStore({ fs, rootDir });

      await expect(store.appendResult(successRecord())).rejects.toMatchObject({
        code: 'FS_FAILED',
      });
      failing.fails = false;
      await store.appendResult(successRecord());

      expect(await nodeFileSystem.exists(path.join(rootDir, 'results.csv'))).toBe(true);
    });
  });
});
