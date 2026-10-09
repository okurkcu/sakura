import type { RunEvent, RunRecord, StageName } from '@bdiff/core';

import type { Metric, RunState, RunSummary } from '../api.js';

export { PANEL_STAGES } from '../stages.js';

/** What the panel read about one run. */
export interface RunFiles {
  readonly runId: string;
  /** `run.json`, once the run ended. */
  readonly record?: RunRecord;
  /** `events.jsonl` so far. */
  readonly events: readonly RunEvent[];
}

const NO_FINDINGS = { info: 0, warning: 0, breaking: 0, unexpected: 0 } as const;

/**
 * The table row of a run: from its record when it ended, else from its events. A run without a
 * record whose process is gone (and that never reported `run-finished`) was interrupted. A run
 * with neither is `undefined` (a directory being created). Pure.
 */
export function summarizeRun(
  files: RunFiles,
  now: Date,
  isAlive: (pid: number) => boolean,
): RunSummary | undefined {
  const { record, events } = files;
  if (record !== undefined) {
    return {
      runId: files.runId,
      state: record.status,
      target: record.target,
      dataset: record.dataset,
      llmMode: record.llmMode,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      findings: record.findingSummary,
      costUsd: record.totals.llmCostUsd,
      note: recordNote(record),
    };
  }
  const started = events.find((event) => event.type === 'run-started');
  if (started?.type !== 'run-started') {
    return undefined;
  }
  const finished = events.some((event) => event.type === 'run-finished');
  const state: RunState = finished || isAlive(started.pid) ? 'running' : 'interrupted';
  const currentStage = stageInProgress(events);
  const last = events.at(-1)?.at ?? started.at;
  const end = state === 'running' ? now.getTime() : Date.parse(last);
  return {
    runId: files.runId,
    state,
    target: started.target,
    dataset: null,
    llmMode: started.llmMode,
    startedAt: started.at,
    durationMs: Math.max(0, end - Date.parse(started.at)),
    findings: NO_FINDINGS,
    costUsd: 0,
    note:
      state === 'interrupted'
        ? `stopped${currentStage === undefined ? '' : ` during ${currentStage}`}: its process is gone`
        : finished
          ? 'finishing'
          : currentStage === undefined
            ? 'starting'
            : `running ${currentStage}`,
    ...(currentStage === undefined ? {} : { currentStage }),
  };
}

/** The stage that started last and has not ended, if any. Pure. */
export function stageInProgress(events: readonly RunEvent[]): StageName | undefined {
  let current: StageName | undefined;
  for (const event of events) {
    if (event.type === 'stage-started') {
      current = event.stage;
    } else if (
      (event.type === 'stage-finished' || event.type === 'stage-failed') &&
      event.stage === current
    ) {
      current = undefined;
    }
  }
  return current;
}

function recordNote(record: RunRecord): string {
  switch (record.status) {
    case 'skipped':
      return `skipped: ${record.skip.reason}`;
    case 'failed':
      return `${record.failure.code}${record.failure.stage === undefined ? '' : ` at ${record.failure.stage}`}`;
    case 'success': {
      const parts = [
        `${String(record.counts.findings)} finding${record.counts.findings === 1 ? '' : 's'}`,
      ];
      if (record.riskLevel !== null) {
        parts.push(`risk ${record.riskLevel}`);
      }
      if (record.llmMode !== 'on') {
        parts.push(`llm ${record.llmMode}`);
      }
      return parts.join(' · ');
    }
  }
}

/** Runs newest first (run ids are ULIDs, so they sort by start time). Pure. */
export function newestFirst(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
}

/**
 * The experiment's numbers the metric cards need, computed by `bdiff stats` (injected by the CLI
 * so the panel and `stats.json` agree).
 */
export interface ExperimentNumbers {
  readonly setup: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly rate: number | null;
  };
  /** Median wall time of runs that were not skipped. */
  readonly durationMs: { readonly count: number; readonly median: number | null };
  /** LLM cost per run. */
  readonly llmCostUsd: { readonly count: number; readonly median: number | null };
  /** Targets: setup rate (0..1) and median duration (ms). */
  readonly targets: { readonly setupRate: number; readonly medianDurationMs: number };
}

/**
 * The four metric cards: setup success and median run time against the experiment's targets, how
 * many raw differences the noise filter removed, and LLM cost per PR. Pure.
 */
export function buildMetrics(numbers: ExperimentNumbers, records: readonly RunRecord[]): Metric[] {
  const { setup, durationMs, llmCostUsd, targets } = numbers;
  const raw = records.reduce((sum, record) => sum + record.counts.rawDiffs, 0);
  const noise = records.reduce((sum, record) => sum + record.counts.noiseDiffs, 0);
  const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
  return [
    {
      id: 'setup-success',
      label: 'Setup success',
      value: setup.rate === null ? '—' : `${String(Math.round(setup.rate * 100))}%`,
      fraction: setup.rate,
      target: `≥ ${String(Math.round(targets.setupRate * 100))}%`,
      verdict:
        setup.rate === null
          ? 'not-measured'
          : setup.rate >= targets.setupRate
            ? 'on-track'
            : 'off-track',
      basis: `${String(setup.succeeded)} of ${String(setup.attempted)} runs that set up apps`,
    },
    {
      id: 'median-duration',
      label: 'Median run',
      value: durationMs.median === null ? '—' : minutes(durationMs.median),
      fraction:
        durationMs.median === null
          ? null
          : Math.min(1, durationMs.median / targets.medianDurationMs),
      target: `< ${minutes(targets.medianDurationMs)}`,
      verdict:
        durationMs.median === null
          ? 'not-measured'
          : durationMs.median < targets.medianDurationMs
            ? 'on-track'
            : 'off-track',
      basis: `${String(durationMs.count)} runs, skipped ones left out`,
    },
    {
      id: 'noise-filtered',
      label: 'Noise filtered',
      value: raw === 0 ? '—' : `${String(Math.round((noise / raw) * 100))}%`,
      fraction: raw === 0 ? null : noise / raw,
      target: 'masked, never reported',
      verdict: raw === 0 ? 'not-measured' : 'info',
      basis: `${String(noise)} of ${String(raw)} raw differences`,
    },
    {
      id: 'cost-per-pr',
      label: 'Cost per PR',
      value: llmCostUsd.median === null ? '—' : `$${llmCostUsd.median.toFixed(4)}`,
      fraction: null,
      target: 'median LLM spend',
      verdict: llmCostUsd.median === null ? 'not-measured' : 'info',
      basis: `${String(llmCostUsd.count)} runs`,
    },
  ];
}
