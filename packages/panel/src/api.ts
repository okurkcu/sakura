/**
 * What the panel's HTTP API returns. Shared by the server and the web UI (type-only, so the UI
 * bundle never pulls in server code).
 */
import type {
  FindingSummary,
  LlmMode,
  RunDataset,
  RunEvent,
  RunRecord,
  RunResult,
  StageName,
  Target,
} from '@bdiff/core';

/** A run as the panel shows it: a finished record, or a run still in progress. */
export type RunState = 'running' | 'success' | 'failed' | 'skipped' | 'interrupted';

/** One row of the runs table. */
export interface RunSummary {
  readonly runId: string;
  readonly state: RunState;
  readonly target: Target;
  readonly dataset: RunDataset | null;
  readonly llmMode: LlmMode;
  readonly startedAt: string;
  /** Final duration, or the time elapsed so far for a run in progress. */
  readonly durationMs: number;
  readonly findings: FindingSummary;
  readonly costUsd: number;
  /** A short line: skip reason, failure code and stage, or the stage in progress. */
  readonly note: string;
  /** The stage running now (runs in progress only). */
  readonly currentStage?: StageName;
}

/** An experiment number against its target. */
export interface Metric {
  readonly id: 'setup-success' | 'median-duration' | 'noise-filtered' | 'cost-per-pr';
  readonly label: string;
  /** Readable value, e.g. `62%`, `4.2 min`, `$0.0123`; `—` when not measured. */
  readonly value: string;
  /** 0..1, for the bar; `null` when not measured. */
  readonly fraction: number | null;
  readonly target: string;
  readonly verdict: 'on-track' | 'off-track' | 'not-measured' | 'info';
  /** What it was computed from, e.g. `5 of 8 runs`. */
  readonly basis: string;
}

/** `GET /api/runs`. */
export interface RunsResponse {
  readonly runs: readonly RunSummary[];
  readonly metrics: readonly Metric[];
  /** Run directories whose files could not be read (e.g. an invalid `run.json`). */
  readonly unreadable: number;
}

/** `GET /api/runs/:id`. */
export interface RunDetailResponse {
  readonly summary: RunSummary;
  /** The final record; absent while the run is in progress. */
  readonly record?: RunRecord;
  /** Everything the run produced; absent while running or for runs from before `result.json`. */
  readonly result?: RunResult;
  readonly events: readonly RunEvent[];
  /** Files of the run directory the panel can serve, relative to it (logs, report, compose…). */
  readonly files: readonly string[];
}

/** Docker as the panel sees it. */
export type DockerStatus = 'connected' | 'unavailable' | 'unknown';

/** A fixture suite started from the panel. */
export interface SuiteJob {
  readonly state: 'running' | 'finished' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** What went wrong, for `failed`. */
  readonly message?: string;
}

/** `GET /api/status`: the sidebar's environment block. */
export interface StatusResponse {
  /** Demo data (`bdiff ui --demo`) rather than a real workspace. */
  readonly demo: boolean;
  readonly workspace: string;
  readonly toolVersion: string;
  /** The mode a run started now would use (from `ANTHROPIC_API_KEY`). */
  readonly llmMode: LlmMode;
  readonly docker: DockerStatus;
  /** Whether "Re-run suite" can start the fixture suite here. */
  readonly canRunSuite: boolean;
  readonly suite: SuiteJob | null;
}

/** One check of the fixture suite. */
export interface FixtureCheck {
  readonly id: string;
  readonly title: string;
  readonly status: 'pass' | 'fail' | 'missing';
  readonly expected: string;
  readonly actual: string;
  /** The run the check looked at. */
  readonly runId?: string;
  /** The stage that owns a failure, e.g. `diff`. */
  readonly stage?: StageName;
  /** Details of a failure, one per line. */
  readonly problems: readonly string[];
  /** Screenshots showing a noise failure: baseA, baseB and head of one page. */
  readonly evidence?: {
    readonly runId: string;
    readonly route: string;
    readonly screenshots: Readonly<Partial<Record<'baseA' | 'baseB' | 'head', string>>>;
  };
  /** A command that runs the branch again. */
  readonly rerun?: string;
}

/** `GET /api/fixture`. */
export interface FixtureResponse {
  /** `false` when `fixtures/expected.json` is not available (e.g. outside the bdiff checkout). */
  readonly available: boolean;
  readonly checks: readonly FixtureCheck[];
  /** When the newest fixture run started. */
  readonly lastRunAt: string | null;
}
