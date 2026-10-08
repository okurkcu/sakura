import path from 'node:path';

import type { ArtifactPaths, FileSystem, RunResult, Stage } from '@bdiff/core';

import { batchIndexHtml } from './batch-index.js';
import type { BatchEntry } from './batch-index.js';
import { runReportHtml } from './run-report.js';
import type { LogTail } from './run-report.js';

/** Lines of each log shown on a failed run's page. */
const LOG_TAIL_LINES = 40;

/**
 * Writes the report of a run to `report/index.html`. For a setup (environment) failure without a
 * recorded log tail, the last lines of the run's logs are read and shown.
 */
export async function renderRunReport(
  result: RunResult,
  paths: ArtifactPaths,
  fs: FileSystem,
): Promise<void> {
  const logFiles = (await fs.exists(paths.logsDir))
    ? (await fs.readdir(paths.logsDir))
        .filter((name) => name.endsWith('.log'))
        .map((name) => path.join(paths.logsDir, name))
    : [];
  const needsTails =
    result.record.status === 'failed' &&
    result.record.failure.stage === 'environment' &&
    !Array.isArray(result.record.failure.details.logTail);
  const logTails: LogTail[] = [];
  if (needsTails) {
    for (const file of logFiles) {
      const lines = (await fs.readFile(file)).trimEnd().split('\n');
      logTails.push({ name: path.basename(file), lines: lines.slice(-LOG_TAIL_LINES) });
    }
  }
  await fs.mkdir(paths.reportDir);
  await fs.writeFile(paths.reportHtml, runReportHtml(result, { paths, logTails, logFiles }));
}

/** Writes the index of a batch of runs to `file`. */
export async function renderBatchIndex(
  entries: readonly BatchEntry[],
  file: string,
  fs: FileSystem,
): Promise<void> {
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, batchIndexHtml(entries));
}

/** Dependencies of the report stage. */
export interface ReportStageDeps {
  readonly fs: FileSystem;
}

/** The report stage: renders the run's HTML report. Runs after every run, failed or skipped too. */
export function createReportStage(deps: ReportStageDeps): Stage<RunResult, void> {
  return {
    name: 'report',
    run: async (result, ctx) => {
      await renderRunReport(result, ctx.paths, deps.fs);
      ctx.logger.info('report written', { file: ctx.paths.reportHtml });
    },
  };
}
