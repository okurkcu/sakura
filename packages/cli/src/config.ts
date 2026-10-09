import { BdiffError, TargetSchema } from '@bdiff/core';
import type { LogLevel, Target } from '@bdiff/core';
import { z } from 'zod';

import type { BatchMode, Shard } from './batch.js';
import { DATASET_TAG_NAMES, parseTagFilters } from './dataset.js';
import type { DatasetTagName, TagFilter } from './dataset.js';

/** Log levels accepted by `--log-level`. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

/** Defaults for `bdiff run`. */
export const RUN_DEFAULTS = {
  outDir: '.bdiff',
  timeoutMinutes: 20,
  budgetUsd: 1,
  logLevel: 'info',
} as const;

/** Environment variables `bdiff run` reads; flags take precedence. */
export const RUN_ENV = {
  outDir: 'BDIFF_OUT',
  timeoutMinutes: 'BDIFF_TIMEOUT_MIN',
  budgetUsd: 'BDIFF_BUDGET_USD',
  logLevel: 'BDIFF_LOG_LEVEL',
} as const;

/** `bdiff run` options as commander parsed them: raw strings, all optional. */
export interface RunFlags {
  readonly repo?: string;
  readonly base?: string;
  readonly head?: string;
  readonly pr?: string;
  readonly out?: string;
  readonly timeout?: string;
  readonly budget?: string;
  readonly logLevel?: string;
}

/** A validated `bdiff run` configuration. */
export interface RunConfig {
  readonly target: Target;
  readonly outDir: string;
  readonly timeoutMs: number;
  readonly budgetUsd: number;
  readonly logLevel: LogLevel;
}

const decimal = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a non-negative number`)
    .transform(Number);

const RawCommonSchema = z.object({
  out: z.string().trim().min(1, 'the output directory must not be empty'),
  timeout: decimal('the timeout (minutes)').refine(
    (minutes) => minutes > 0 && minutes <= 24 * 60,
    'the timeout must be more than 0 and at most 1440 minutes',
  ),
  budget: decimal('the budget (USD)').refine(
    (usd) => usd <= 100,
    'the budget must be at most 100 USD',
  ),
  logLevel: z.enum(LOG_LEVELS, { error: `the log level must be one of ${LOG_LEVELS.join(', ')}` }),
});

const RawRunConfigSchema = z
  .object({
    repo: z.string({ error: '--repo is required' }).trim().min(1, '--repo must not be empty'),
    base: z.string({ error: '--base is required' }).trim().min(1, '--base must not be empty'),
    head: z.string({ error: '--head is required' }).trim().min(1, '--head must not be empty'),
    pr: z
      .string()
      .trim()
      .regex(/^[1-9]\d*$/, '--pr must be a positive integer')
      .transform(Number)
      .optional(),
  })
  .extend(RawCommonSchema.shape);

/** `bdiff batch` options as commander parsed them. */
export interface BatchFlags {
  readonly out?: string;
  readonly timeout?: string;
  readonly budget?: string;
  readonly logLevel?: string;
  readonly concurrency?: string;
  readonly resume?: boolean;
  readonly force?: boolean;
  readonly only?: readonly string[];
  readonly shard?: string;
}

/** A validated `bdiff batch` configuration. */
export interface BatchConfig {
  readonly datasetFile: string;
  readonly outDir: string;
  /** Per run. */
  readonly timeoutMs: number;
  /** Per run. */
  readonly budgetUsd: number;
  readonly logLevel: LogLevel;
  readonly concurrency: number;
  readonly mode: BatchMode;
  readonly only: readonly TagFilter[];
  /** Run only this shard of the selected entries (`--shard i/n`). */
  readonly shard?: Shard;
}

/** Most shards a batch can be split into. */
export const MAX_SHARDS = 100;

/** Most runs a batch may run at once (Docker resources). */
export const MAX_BATCH_CONCURRENCY = 2;

const RawBatchSchema = z.object({
  dataset: z.string().trim().min(1, 'the dataset file must not be empty'),
  concurrency: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, '--concurrency must be a positive integer')
    .transform(Number)
    .refine(
      (n) => n <= MAX_BATCH_CONCURRENCY,
      `--concurrency must be at most ${String(MAX_BATCH_CONCURRENCY)}`,
    ),
  resume: z.boolean(),
  force: z.boolean(),
  shard: z
    .string()
    .trim()
    .regex(/^[1-9]\d*\/[1-9]\d*$/, '--shard must be <i>/<n>, e.g. 2/4')
    .transform((value) => {
      const [index = 0, count = 0] = value.split('/').map(Number);
      return { index, count };
    })
    .refine((shard) => shard.index <= shard.count, '--shard i/n needs i ≤ n')
    .refine(
      (shard) => shard.count <= MAX_SHARDS,
      `--shard allows at most ${String(MAX_SHARDS)} shards`,
    )
    .optional(),
});

/**
 * Validates `bdiff batch`: the dataset file, the shared run options (flags over environment over
 * defaults, as for `bdiff run`), `--concurrency` (1 or 2), `--resume` or `--force` (not both) and
 * `--only` filters.
 *
 * @throws BdiffError `INVALID_INPUT` listing every problem.
 */
export function parseBatchConfig(
  datasetFile: string,
  flags: BatchFlags,
  env: Readonly<Record<string, string | undefined>>,
): BatchConfig {
  const problems: string[] = [];
  const common = parseCommon(flags, env, problems);
  const batch = RawBatchSchema.safeParse({
    dataset: datasetFile,
    concurrency: flags.concurrency ?? '1',
    resume: flags.resume ?? false,
    force: flags.force ?? false,
    shard: flags.shard,
  });
  if (!batch.success) {
    problems.push(...batch.error.issues.map((issue) => issue.message));
  } else if (batch.data.resume && batch.data.force) {
    problems.push('--resume and --force cannot be combined');
  }
  let only: TagFilter[] = [];
  try {
    only = parseTagFilters(flags.only ?? []);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0 || common === undefined || !batch.success) {
    throw usageError(problems);
  }
  return {
    ...common,
    datasetFile: batch.data.dataset,
    concurrency: batch.data.concurrency,
    mode: batch.data.resume ? 'resume' : batch.data.force ? 'force' : 'fresh',
    only,
    ...(batch.data.shard === undefined ? {} : { shard: batch.data.shard }),
  };
}

/** `bdiff stats` options as commander parsed them. */
export interface StatsFlags {
  readonly out?: string;
  readonly by?: string;
  readonly logLevel?: string;
  readonly markdown?: string;
}

/** A validated `bdiff stats` configuration. */
export interface StatsConfig {
  readonly outDir: string;
  readonly by?: DatasetTagName;
  readonly logLevel: LogLevel;
  /** Also write the statistics as Markdown to this file (e.g. a CI job summary). */
  readonly markdownFile?: string;
}

/**
 * Validates `bdiff stats`: `--out` and `--log-level` as for `bdiff run`, `--by` one of the
 * dataset tags.
 *
 * @throws BdiffError `INVALID_INPUT` listing every problem.
 */
export function parseStatsConfig(
  flags: StatsFlags,
  env: Readonly<Record<string, string | undefined>>,
): StatsConfig {
  const problems: string[] = [];
  const common = parseCommon(flags, env, problems);
  const by = DATASET_TAG_NAMES.find((name) => name === flags.by);
  if (flags.by !== undefined && by === undefined) {
    problems.push(`--by must be one of ${DATASET_TAG_NAMES.join(', ')}`);
  }
  if (problems.length > 0 || common === undefined) {
    throw usageError(problems);
  }
  return {
    outDir: common.outDir,
    logLevel: common.logLevel,
    ...(by === undefined ? {} : { by }),
    ...(flags.markdown === undefined || flags.markdown.trim() === ''
      ? {}
      : { markdownFile: flags.markdown }),
  };
}

/** Options every command shares, validated; `undefined` when some are invalid (in `problems`). */
function parseCommon(
  flags: Pick<RunFlags, 'out' | 'timeout' | 'budget' | 'logLevel'>,
  env: Readonly<Record<string, string | undefined>>,
  problems: string[],
): Pick<RunConfig, 'outDir' | 'timeoutMs' | 'budgetUsd' | 'logLevel'> | undefined {
  const parsed = RawCommonSchema.safeParse({
    out: flags.out ?? env[RUN_ENV.outDir] ?? RUN_DEFAULTS.outDir,
    timeout: flags.timeout ?? env[RUN_ENV.timeoutMinutes] ?? String(RUN_DEFAULTS.timeoutMinutes),
    budget: flags.budget ?? env[RUN_ENV.budgetUsd] ?? String(RUN_DEFAULTS.budgetUsd),
    logLevel: flags.logLevel ?? env[RUN_ENV.logLevel] ?? RUN_DEFAULTS.logLevel,
  });
  if (!parsed.success) {
    problems.push(...parsed.error.issues.map((issue) => issue.message));
    return undefined;
  }
  return {
    outDir: parsed.data.out,
    timeoutMs: Math.round(parsed.data.timeout * 60_000),
    budgetUsd: parsed.data.budget,
    logLevel: parsed.data.logLevel,
  };
}

/**
 * Merges flags over environment variables over defaults and validates the result.
 *
 * @throws BdiffError `INVALID_INPUT` with a readable, multi-line message listing every problem.
 */
export function parseRunConfig(
  flags: RunFlags,
  env: Readonly<Record<string, string | undefined>>,
): RunConfig {
  const raw = {
    repo: flags.repo,
    base: flags.base,
    head: flags.head,
    pr: flags.pr,
    out: flags.out ?? env[RUN_ENV.outDir] ?? RUN_DEFAULTS.outDir,
    timeout: flags.timeout ?? env[RUN_ENV.timeoutMinutes] ?? String(RUN_DEFAULTS.timeoutMinutes),
    budget: flags.budget ?? env[RUN_ENV.budgetUsd] ?? String(RUN_DEFAULTS.budgetUsd),
    logLevel: flags.logLevel ?? env[RUN_ENV.logLevel] ?? RUN_DEFAULTS.logLevel,
  };
  const parsed = RawRunConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(parsed.error.issues.map((issue) => issue.message));
  }
  const { repo, base, head, pr, out, timeout, budget, logLevel } = parsed.data;

  const target = TargetSchema.safeParse({
    repoUrl: repo,
    baseRef: base,
    headRef: head,
    ...(pr === undefined ? {} : { prNumber: pr }),
  });
  if (!target.success) {
    throw usageError(target.error.issues.map((issue) => issue.message));
  }
  return {
    target: target.data,
    outDir: out,
    timeoutMs: Math.round(timeout * 60_000),
    budgetUsd: budget,
    logLevel,
  };
}

function usageError(problems: readonly string[]): BdiffError {
  return new BdiffError(
    'INVALID_INPUT',
    `Invalid arguments:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    {
      details: { problems: [...problems] },
    },
  );
}
