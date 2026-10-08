import type { RunRecord } from './run-record.js';
import { StageNameSchema } from '../domain/stage.js';
import type { StageName } from '../domain/stage.js';

type CsvValue = string | number | undefined;

/** Column name → how to read it from a record. The order here is the column order. */
const COLUMNS: readonly (readonly [string, (record: RunRecord) => CsvValue])[] = [
  ['run_id', (r) => r.runId],
  ['schema_version', (r) => r.schemaVersion],
  ['tool_version', (r) => r.toolVersion],
  ['started_at', (r) => r.startedAt],
  ['finished_at', (r) => r.finishedAt],
  ['duration_ms', (r) => r.durationMs],
  ['status', (r) => r.status],
  ['failure_code', (r) => (r.status === 'failed' ? r.failure.code : undefined)],
  ['failure_stage', (r) => (r.status === 'failed' ? r.failure.stage : undefined)],
  ['failure_message', (r) => (r.status === 'failed' ? r.failure.message : undefined)],
  ['skip_reason', (r) => (r.status === 'skipped' ? r.skip.reason : undefined)],
  ['repo_url', (r) => r.target.repoUrl],
  ['base_ref', (r) => r.target.baseRef],
  ['head_ref', (r) => r.target.headRef],
  ['pr_number', (r) => r.target.prNumber],
  ...StageNameSchema.options.map(
    (stage) => [`ms_${stage.replaceAll('-', '_')}`, (r: RunRecord) => stageMs(r, stage)] as const,
  ),
  ['compute_seconds_base', (r) => r.computeSeconds.base],
  ['compute_seconds_head', (r) => r.computeSeconds.head],
  ['llm_calls', (r) => r.totals.llmCalls],
  ['llm_input_tokens', (r) => r.totals.inputTokens],
  ['llm_output_tokens', (r) => r.totals.outputTokens],
  ['llm_cache_read_tokens', (r) => r.totals.cacheReadTokens],
  ['llm_cache_write_5m_tokens', (r) => r.totals.cacheWrite5mTokens],
  ['llm_cache_write_1h_tokens', (r) => r.totals.cacheWrite1hTokens],
  ['llm_cost_usd', (r) => r.totals.llmCostUsd],
  ['routes_probed', (r) => r.counts.routesProbed],
  ['endpoints_probed', (r) => r.counts.endpointsProbed],
  ['raw_diffs', (r) => r.counts.rawDiffs],
  ['noise_diffs', (r) => r.counts.noiseDiffs],
  ['findings', (r) => r.counts.findings],
];

/**
 * Columns of `results.csv`, in order. This list is a public contract documented in
 * `docs/metrics.md`; a test keeps the two in sync.
 */
export const RESULTS_CSV_COLUMNS: readonly string[] = COLUMNS.map(([name]) => name);

/** The header line of `results.csv`, with trailing newline. */
export function resultsCsvHeader(): string {
  return `${RESULTS_CSV_COLUMNS.join(',')}\n`;
}

/** One `results.csv` line for a record, with trailing newline. Pure. */
export function toResultsCsvRow(record: RunRecord): string {
  return `${COLUMNS.map(([, read]) => csvField(read(record))).join(',')}\n`;
}

/** Total time spent in a stage across all its executions; empty if the stage never ran. */
function stageMs(record: RunRecord, stage: StageName): number | undefined {
  const timings = record.stageTimings.filter((timing) => timing.stage === stage);
  return timings.length === 0
    ? undefined
    : timings.reduce((total, timing) => total + timing.durationMs, 0);
}

/** RFC 4180 field: quoted when it contains a comma, quote or line break; quotes doubled. */
export function csvField(value: CsvValue): string {
  if (value === undefined) {
    return '';
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
