import { BdiffError, TargetSchema } from '@bdiff/core';
import type { LogLevel, Target } from '@bdiff/core';
import { z } from 'zod';

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

const RawRunConfigSchema = z.object({
  repo: z.string({ error: '--repo is required' }).trim().min(1, '--repo must not be empty'),
  base: z.string({ error: '--base is required' }).trim().min(1, '--base must not be empty'),
  head: z.string({ error: '--head is required' }).trim().min(1, '--head must not be empty'),
  pr: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, '--pr must be a positive integer')
    .transform(Number)
    .optional(),
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
