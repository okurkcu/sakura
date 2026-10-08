import { homedir } from 'node:os';
import path from 'node:path';

import {
  BdiffError,
  createCostCalculator,
  createExecaExec,
  createRecipeStage,
  createLogger,
  createStubStages,
  createWorkspaceStage,
  DEFAULT_BUDGET_USD,
  loadPricingTable,
  nodeFileSystem,
  runPipeline,
  systemClock,
} from '@bdiff/core';
import type {
  Clock,
  Exec,
  FileSystem,
  Logger,
  LogLevel,
  PipelineStages,
  RunRecord,
} from '@bdiff/core';
import { Command, CommanderError } from 'commander';

import { parseRunConfig, RUN_DEFAULTS, RUN_ENV } from './config.js';
import type { RunFlags } from './config.js';
import { resolveToolVersion } from './tool-version.js';

/** Process exit codes of `bdiff`. */
export const EXIT_CODES = {
  success: 0,
  failed: 1,
  usage: 2,
  interrupted: 130,
} as const;

/** Signals that stop a run gracefully. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type StopSignal = (typeof STOP_SIGNALS)[number];

/** Where interrupts come from; `process` in production. */
export interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

/** The process boundary of the CLI. */
export interface CliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signals: SignalSource;
  /** Exits immediately; used when a second interrupt arrives during cleanup. */
  readonly forceExit: (code: number) => void;
}

/** Adapters and stages the CLI wires into the pipeline. */
export interface CliDeps {
  readonly clock: Clock;
  readonly fs: FileSystem;
  readonly exec: Exec;
  readonly stages: PipelineStages;
  readonly createLogger: (level: LogLevel) => Logger;
  readonly pricingPath: string;
  /** Base for relative paths such as `--out`. */
  readonly cwd: string;
}

/** Root of the bdiff checkout (`packages/cli/{src,dist}/` → `../../..`). */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * The real adapters. This is the composition root: the only place that chooses implementations.
 * Stages not implemented yet are stubs; each stage task swaps in its real implementation here.
 */
export function createDefaultCliDeps(env: Readonly<Record<string, string | undefined>>): CliDeps {
  const exec = createExecaExec();
  const cwd = process.cwd();
  const cache = cacheDir(env);
  return {
    clock: systemClock,
    fs: nodeFileSystem,
    exec,
    stages: {
      ...createStubStages(),
      workspace: createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir: cache, cwd }),
      recipe: createRecipeStage({ fs: nodeFileSystem, cacheDir: cache, cwd }),
    },
    createLogger: (level) => createLogger({ level }),
    pricingPath: env.BDIFF_PRICING ?? path.join(REPO_ROOT, 'config', 'pricing.json'),
    cwd,
  };
}

/** `BDIFF_CACHE_DIR`, else `$XDG_CACHE_HOME/bdiff`, else `~/.cache/bdiff`. */
export function cacheDir(env: Readonly<Record<string, string | undefined>>): string {
  return (
    env.BDIFF_CACHE_DIR ?? path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'bdiff')
  );
}

/**
 * Runs the `bdiff` command line and returns the exit code: 0 success or skipped, 1 run failed (and
 * recorded), 2 invalid usage, 130 interrupted (after cleanup ran).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = createDefaultCliDeps(io.env),
): Promise<number> {
  let runFlags: RunFlags | undefined;
  const program = new Command('bdiff')
    .description('Behavior diff for pull requests: run base and head, show how behavior changed.')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    });
  program
    .command('run')
    .description('Compare the behavior of a base and a head ref of a repository.')
    .requiredOption('--repo <url|path>', 'repository URL or local path')
    .requiredOption('--base <ref>', 'base ref')
    .requiredOption('--head <ref>', 'head ref')
    .option('--pr <number>', 'pull request number')
    .option(
      '--out <dir>',
      `output directory (env ${RUN_ENV.outDir}, default ${RUN_DEFAULTS.outDir})`,
    )
    .option(
      '--timeout <minutes>',
      `run timeout in minutes (env ${RUN_ENV.timeoutMinutes}, default ${String(RUN_DEFAULTS.timeoutMinutes)})`,
    )
    .option(
      '--budget <usd>',
      `LLM budget in USD (env ${RUN_ENV.budgetUsd}, default ${String(DEFAULT_BUDGET_USD)})`,
    )
    .option('--log-level <level>', `debug, info, warn or error (env ${RUN_ENV.logLevel})`)
    .action((options: RunFlags) => {
      runFlags = options;
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.usage;
    }
    throw error;
  }
  if (runFlags === undefined) {
    program.outputHelp({ error: true });
    return EXIT_CODES.usage;
  }
  return run(runFlags, io, deps);
}

async function run(flags: RunFlags, io: CliIo, deps: CliDeps): Promise<number> {
  let config;
  try {
    config = parseRunConfig(flags, io.env);
  } catch (error) {
    io.stderr.write(`bdiff: ${describe(error)}\nRun "bdiff run --help" for usage.\n`);
    return EXIT_CODES.usage;
  }

  const logger = deps.createLogger(config.logLevel);
  // Only a stop signal aborts this controller, so `aborted` means "interrupted".
  const controller = new AbortController();
  const interrupted = () => controller.signal.aborted;
  const onSignal = (signal: StopSignal) => () => {
    if (interrupted()) {
      io.stderr.write('bdiff: forced exit; cleanup was not finished\n');
      io.forceExit(EXIT_CODES.interrupted);
      return;
    }
    io.stderr.write(`bdiff: ${signal} received; cleaning up (press Ctrl+C again to force quit)\n`);
    controller.abort(new BdiffError('ABORTED', `Interrupted by ${signal}`));
  };
  const listeners = STOP_SIGNALS.map((signal) => [signal, onSignal(signal)] as const);
  for (const [signal, listener] of listeners) {
    io.signals.on(signal, listener);
  }

  try {
    const costs = createCostCalculator(await loadPricingTable(deps.fs, deps.pricingPath));
    const toolVersion = await resolveToolVersion({
      env: io.env,
      exec: deps.exec,
      cwd: REPO_ROOT,
      signal: controller.signal,
      logger,
    });
    const { result, runJsonPath } = await runPipeline(config.target, deps.stages, {
      clock: deps.clock,
      fs: deps.fs,
      logger,
      costs,
      outDir: path.resolve(deps.cwd, config.outDir),
      toolVersion,
      timeoutMs: config.timeoutMs,
      budgetUsd: config.budgetUsd,
      signal: controller.signal,
    });
    io.stdout.write(summarize(result.record, runJsonPath));
    if (interrupted()) {
      return EXIT_CODES.interrupted;
    }
    return result.record.status === 'failed' ? EXIT_CODES.failed : EXIT_CODES.success;
  } catch (error) {
    io.stderr.write(`bdiff: the run could not be recorded: ${describe(error)}\n`);
    return interrupted() ? EXIT_CODES.interrupted : EXIT_CODES.failed;
  } finally {
    for (const [signal, listener] of listeners) {
      io.signals.off(signal, listener);
    }
  }
}

/** One short, human-readable summary of a finished run. */
export function summarize(record: RunRecord, runJsonPath: string): string {
  const seconds = (record.durationMs / 1000).toFixed(1);
  const cost = `LLM $${record.totals.llmCostUsd.toFixed(4)}`;
  const outcome =
    record.status === 'failed'
      ? `failed at ${record.failure.stage ?? 'startup'} (${record.failure.code}): ${record.failure.message}`
      : record.status === 'skipped'
        ? `skipped: ${record.skip.reason}`
        : `success, ${String(record.counts.findings)} findings`;
  return `bdiff: ${outcome}\n  ${seconds}s · ${cost} · run ${record.runId}\n  record: ${runJsonPath}\n`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
