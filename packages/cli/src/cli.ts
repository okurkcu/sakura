import { homedir } from 'node:os';
import path from 'node:path';

import {
  BdiffError,
  createAnthropicLlmClient,
  createArtifactPaths,
  createApiProbeStage,
  createCannedLlmClient,
  createCostCalculator,
  createDependencyCruiserGraph,
  createDiffStage,
  createEnvironmentStage,
  createExecaExec,
  createFetchHttpClient,
  createGitHubClient,
  createImpactStage,
  createInterpretStage,
  createPlaywrightLauncher,
  createRecipeStage,
  createRepairStages,
  createLogger,
  createMetricsStore,
  createOffLlmClient,
  createOutputPaths,
  createUiProbeStage,
  createWorkspaceStage,
  DEFAULT_BUDGET_USD,
  loadLlmConfig,
  loadPricingTable,
  nodeFileSystem,
  pngCodec,
  runPipeline,
  SeveritySchema,
  systemClock,
} from '@bdiff/core';
import type {
  Clock,
  CostCalculator,
  Exec,
  FileSystem,
  Finding,
  LlmClient,
  LlmMode,
  Logger,
  LogLevel,
  PipelineStages,
  PullRequestSource,
  ResolvedLlmMode,
  RunResult,
  Target,
} from '@bdiff/core';
import { createReportStage } from '@bdiff/report';
import { Command, CommanderError } from 'commander';

import { executeBatch, planBatch, shardEntries, writeBatchIndex, writeRunsIndex } from './batch.js';
import {
  MAX_BATCH_CONCURRENCY,
  parseBatchConfig,
  parseRunConfig,
  parseStatsConfig,
  RUN_DEFAULTS,
  RUN_ENV,
} from './config.js';
import type { BatchFlags, RunFlags, StatsFlags } from './config.js';
import { DATASET_TAG_NAMES, loadDataset, selectEntries } from './dataset.js';
import { resolvePullRequestTarget, unresolvedPullRequestTarget } from './pr-url.js';
import { readRunRecords } from './run-records.js';
import { formatStats, formatStatsMarkdown } from './stats-text.js';
import { computeStats, countedRecords } from './stats.js';
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

/** Services the CLI builds per run, once configuration is loaded, and hands to the stages. */
export interface StageServices {
  readonly llm: LlmClient;
}

/** Adapters and stages the CLI wires into the pipeline. */
export interface CliDeps {
  readonly clock: Clock;
  readonly fs: FileSystem;
  readonly exec: Exec;
  /** The stages of a run, given the services built from the run's configuration. */
  readonly createStages: (services: StageServices) => PipelineStages;
  readonly createLogger: (level: LogLevel) => Logger;
  readonly pricingPath: string;
  /** `config/llm.json`: validated (models priced) before every run. */
  readonly llmConfigPath: string;
  /** Base for relative paths such as `--out`. */
  readonly cwd: string;
  /** Resolves `bdiff run <pr-url>`; GitHub in production. */
  readonly pullRequests: PullRequestSource;
}

/** Root of the bdiff checkout (`packages/cli/{src,dist}/` → `../../..`). */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * The real adapters and stages. This is the composition root: the only place that chooses
 * implementations.
 */
export function createDefaultCliDeps(env: Readonly<Record<string, string | undefined>>): CliDeps {
  const exec = createExecaExec();
  const cwd = process.cwd();
  const cache = cacheDir(env);
  const http = createFetchHttpClient();
  const github = createGitHubClient(
    env.GITHUB_TOKEN === undefined || env.GITHUB_TOKEN === '' ? {} : { token: env.GITHUB_TOKEN },
  );
  return {
    clock: systemClock,
    fs: nodeFileSystem,
    exec,
    createStages: ({ llm }) => ({
      workspace: createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir: cache, cwd }),
      impact: createImpactStage({ fs: nodeFileSystem, graph: createDependencyCruiserGraph() }),
      recipe: createRecipeStage({ fs: nodeFileSystem, cacheDir: cache, cwd }),
      environment: createEnvironmentStage({ exec, fs: nodeFileSystem, http }),
      repair: createRepairStages({ fs: nodeFileSystem, llm, cacheDir: cache, cwd }),
      probeUi: createUiProbeStage({ browser: createPlaywrightLauncher(), fs: nodeFileSystem }),
      probeApi: createApiProbeStage({ http, fs: nodeFileSystem, llm }),
      diff: createDiffStage({ fs: nodeFileSystem, images: pngCodec }),
      interpret: createInterpretStage({ llm, exec, github }),
      report: createReportStage({ fs: nodeFileSystem }),
    }),
    createLogger: (level) => createLogger({ level }),
    pullRequests: github,
    pricingPath: env.BDIFF_PRICING ?? path.join(REPO_ROOT, 'config', 'pricing.json'),
    llmConfigPath: path.join(REPO_ROOT, 'config', 'llm.json'),
    cwd,
  };
}

/**
 * The LLM client of a mode: the real one (`on`, built by `real`), one that refuses every call
 * (`off`), or canned answers (`fake`).
 */
function createLlmClient(mode: LlmMode, real: () => LlmClient): LlmClient {
  switch (mode) {
    case 'on':
      return real();
    case 'off':
      return createOffLlmClient();
    case 'fake':
      return createCannedLlmClient();
  }
}

/** `BDIFF_CACHE_DIR`, else `$XDG_CACHE_HOME/bdiff`, else `~/.cache/bdiff`. */
export function cacheDir(env: Readonly<Record<string, string | undefined>>): string {
  return (
    env.BDIFF_CACHE_DIR ?? path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'bdiff')
  );
}

/**
 * Runs the `bdiff` command line and returns the exit code. `run`: 0 success or skipped, 1 run
 * failed (and recorded). `batch`: 0 every entry recorded (whatever its status), 1 some entry could
 * not be recorded. `stats`: 0, or 1 when there is no record. All: 2 invalid usage, 130 interrupted
 * (after cleanup ran).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = createDefaultCliDeps(io.env),
): Promise<number> {
  let command:
    | { readonly name: 'run'; readonly flags: RunFlags }
    | { readonly name: 'batch'; readonly dataset: string; readonly flags: BatchFlags }
    | { readonly name: 'stats'; readonly flags: StatsFlags }
    | undefined;
  const program = new Command('bdiff')
    .description('Behavior diff for pull requests: run base and head, show how behavior changed.')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    });
  const outOption = `output directory (env ${RUN_ENV.outDir}, default ${RUN_DEFAULTS.outDir})`;
  const timeoutOption = `run timeout in minutes (env ${RUN_ENV.timeoutMinutes}, default ${String(RUN_DEFAULTS.timeoutMinutes)})`;
  const budgetOption = `LLM budget in USD (env ${RUN_ENV.budgetUsd}, default ${String(DEFAULT_BUDGET_USD)})`;
  const logLevelOption = `debug, info, warn or error (env ${RUN_ENV.logLevel})`;
  const llmOption = `on, off or fake (env ${RUN_ENV.llmMode}; default on with ANTHROPIC_API_KEY, else off)`;
  program
    .command('run')
    .description(
      'Compare the behavior of a base and a head ref of a repository, or of a GitHub pull request.',
    )
    .argument('[pr-url]', 'a GitHub pull request URL, instead of --repo, --base, --head and --pr')
    .option('--repo <url|path>', 'repository URL or local path')
    .option('--base <ref>', 'base ref')
    .option('--head <ref>', 'head ref')
    .option('--pr <number>', 'pull request number')
    .option('--out <dir>', outOption)
    .option('--timeout <minutes>', timeoutOption)
    .option('--budget <usd>', budgetOption)
    .option('--log-level <level>', logLevelOption)
    .option('--llm <mode>', llmOption)
    .action((prUrl: string | undefined, flags: RunFlags) => {
      command = {
        name: 'run',
        flags: prUrl === undefined ? flags : { ...flags, prUrl },
      };
    });
  program
    .command('batch')
    .description('Run every pull request of a dataset file, then write the batch index.')
    .argument('<dataset>', 'dataset JSON file')
    .option(
      '--concurrency <n>',
      `runs at a time, at most ${String(MAX_BATCH_CONCURRENCY)} (default 1)`,
    )
    .option('--resume', 'skip entries already recorded by this bdiff version')
    .option('--force', 'run entries again even if this bdiff version recorded them')
    .option('--shard <i/n>', 'run only the i-th of n parts of the (filtered) entries, round robin')
    .option(
      '--only <tag=value>',
      `run only matching entries (${DATASET_TAG_NAMES.join(', ')}); repeatable`,
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--out <dir>', outOption)
    .option('--timeout <minutes>', `${timeoutOption}, per run`)
    .option('--budget <usd>', `${budgetOption}, per run`)
    .option('--log-level <level>', logLevelOption)
    .option('--llm <mode>', llmOption)
    .action((dataset: string, flags: BatchFlags) => {
      command = { name: 'batch', dataset, flags };
    });
  program
    .command('stats')
    .description('Aggregate the experiment metrics over the recorded runs; writes stats.json.')
    .option('--by <tag>', `also group by a dataset tag (${DATASET_TAG_NAMES.join(', ')})`)
    .option('--markdown <file>', 'also write the statistics as Markdown (e.g. a CI job summary)')
    .option('--out <dir>', outOption)
    .option('--log-level <level>', logLevelOption)
    .action((flags: StatsFlags) => {
      command = { name: 'stats', flags };
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.usage;
    }
    throw error;
  }
  switch (command?.name) {
    case 'run':
      return run(command.flags, io, deps);
    case 'batch':
      return batch(command.dataset, command.flags, io, deps);
    case 'stats':
      return stats(command.flags, io, deps);
    case undefined:
      program.outputHelp({ error: true });
      return EXIT_CODES.usage;
  }
}

/** What a command that runs the pipeline needs, once configuration is loaded. */
interface Session {
  readonly logger: Logger;
  /** Aborted by SIGINT or SIGTERM. */
  readonly signal: AbortSignal;
  readonly interrupted: () => boolean;
  readonly costs: CostCalculator;
  readonly llm: LlmClient;
  readonly llmMode: LlmMode;
  readonly toolVersion: string;
}

/**
 * Runs `body` with stop-signal handling (a second interrupt force-quits) and the run services:
 * pricing, LLM client, tool version. An error that escapes `body` means nothing could be recorded.
 */
async function withSession(
  io: CliIo,
  deps: CliDeps,
  options: { readonly logLevel: LogLevel; readonly llm: ResolvedLlmMode },
  body: (session: Session) => Promise<number>,
): Promise<number> {
  const { logLevel } = options;
  const llmMode = options.llm.mode;
  if (options.llm.defaulted) {
    io.stderr.write(
      'bdiff: ANTHROPIC_API_KEY is not set, so the LLM is off (no interpretation, no setup repair); --llm fake shows canned answers\n',
    );
  } else if (llmMode === 'fake') {
    io.stderr.write('bdiff: --llm fake: interpretations are canned, no model is called\n');
  }
  const logger = deps.createLogger(logLevel);
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
    const pricing = await loadPricingTable(deps.fs, deps.pricingPath);
    const llmConfig = await loadLlmConfig(deps.fs, deps.llmConfigPath, pricing);
    const llm = createLlmClient(llmMode, () =>
      // Credentials are only needed by a run that calls the LLM; the SDK reads them from the env.
      createAnthropicLlmClient({ config: llmConfig }),
    );
    const toolVersion = await resolveToolVersion({
      env: io.env,
      exec: deps.exec,
      cwd: REPO_ROOT,
      signal: controller.signal,
      logger,
    });
    return await body({
      logger,
      signal: controller.signal,
      interrupted,
      costs: createCostCalculator(pricing),
      llm,
      llmMode,
      toolVersion,
    });
  } catch (error) {
    io.stderr.write(`bdiff: the run could not be recorded: ${describe(error)}\n`);
    return interrupted() ? EXIT_CODES.interrupted : EXIT_CODES.failed;
  } finally {
    for (const [signal, listener] of listeners) {
      io.signals.off(signal, listener);
    }
  }
}

async function run(flags: RunFlags, io: CliIo, deps: CliDeps): Promise<number> {
  let config;
  try {
    config = parseRunConfig(flags, io.env);
  } catch (error) {
    return usage(io, 'run', error);
  }
  return withSession(io, deps, config, async (session) => {
    const outDir = path.resolve(deps.cwd, config.outDir);
    let target: Target;
    let stages = deps.createStages({ llm: session.llm });
    if ('target' in config) {
      target = config.target;
    } else {
      try {
        target = await resolvePullRequestTarget(
          config.pullRequest,
          deps.pullRequests,
          session.signal,
        );
        session.logger.info('pull request resolved', {
          repoUrl: target.repoUrl,
          baseRef: target.baseRef,
          headRef: target.headRef,
        });
      } catch (error) {
        // Record and report it like any failed run: as the workspace stage, which needs the PR.
        const failure = error instanceof Error ? error : new Error(String(error));
        target = unresolvedPullRequestTarget(config.pullRequest);
        stages = {
          ...stages,
          workspace: { name: 'workspace', run: () => Promise.reject(failure) },
        };
      }
    }
    const { result, runJsonPath } = await runPipeline(target, stages, {
      clock: deps.clock,
      fs: deps.fs,
      logger: session.logger,
      costs: session.costs,
      outDir,
      toolVersion: session.toolVersion,
      timeoutMs: config.timeoutMs,
      budgetUsd: config.budgetUsd,
      signal: session.signal,
      llmMode: session.llmMode,
    });
    const reportPath = createArtifactPaths(outDir, result.record.runId).reportHtml;
    io.stdout.write(
      summarize(result, {
        runJsonPath,
        // A failed report stage may leave no page behind.
        ...((await deps.fs.exists(reportPath)) ? { reportPath } : {}),
      }),
    );
    if (session.interrupted()) {
      return EXIT_CODES.interrupted;
    }
    return result.record.status === 'failed' ? EXIT_CODES.failed : EXIT_CODES.success;
  });
}

async function batch(
  datasetFile: string,
  flags: BatchFlags,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  let config;
  let entries;
  try {
    config = parseBatchConfig(datasetFile, flags, io.env);
    const dataset = await loadDataset(deps.fs, path.resolve(deps.cwd, config.datasetFile));
    const selected = selectEntries(dataset.entries, config.only);
    entries = config.shard === undefined ? selected : shardEntries(selected, config.shard);
  } catch (error) {
    return usage(io, 'batch', error);
  }
  const { mode, concurrency, timeoutMs, budgetUsd } = config;
  return withSession(io, deps, config, async (session) => {
    const outDir = path.resolve(deps.cwd, config.outDir);
    const before = await readRunRecords(deps.fs, outDir, session.logger);
    const plan = planBatch(entries, before.records, session.toolVersion, mode);
    if (mode === 'fresh' && plan.done.length > 0) {
      io.stderr.write(
        `bdiff: ${String(plan.done.length)} of these entries already have a record from this bdiff version (${session.toolVersion}) in ${outDir}; use --resume to skip them or --force to run them again\n`,
      );
      return EXIT_CODES.usage;
    }
    io.stdout.write(
      `bdiff batch: ${String(entries.length)} entries, ${String(plan.toRun.length)} to run${mode === 'resume' ? `, ${String(plan.done.length)} already recorded` : ''}\n`,
    );
    const outcome = await executeBatch(
      plan.toRun,
      { outDir, concurrency, timeoutMs, budgetUsd, llmMode: session.llmMode },
      {
        clock: deps.clock,
        fs: deps.fs,
        logger: session.logger,
        costs: session.costs,
        toolVersion: session.toolVersion,
        store: createMetricsStore({ fs: deps.fs, rootDir: outDir }),
        createStages: () => deps.createStages({ llm: session.llm }),
        signal: session.signal,
        print: (line) => io.stdout.write(`  ${line}\n`),
      },
    );
    const after = await readRunRecords(deps.fs, outDir, session.logger);
    const indexFile = createOutputPaths(outDir).batchIndexHtml;
    await writeBatchIndex(deps.fs, indexFile, outDir, entries, after.records);
    io.stdout.write(
      `bdiff batch: ${String(outcome.recorded.length)} recorded, ${String(outcome.unrecorded.length)} not recorded${session.interrupted() ? ', interrupted (run again with --resume)' : ''}\n  index: ${indexFile}\n`,
    );
    if (session.interrupted()) {
      return EXIT_CODES.interrupted;
    }
    return outcome.unrecorded.length > 0 ? EXIT_CODES.failed : EXIT_CODES.success;
  });
}

async function stats(flags: StatsFlags, io: CliIo, deps: CliDeps): Promise<number> {
  let config;
  try {
    config = parseStatsConfig(flags, io.env);
  } catch (error) {
    return usage(io, 'stats', error);
  }
  const logger = deps.createLogger(config.logLevel);
  const outDir = path.resolve(deps.cwd, config.outDir);
  const { records, unreadable } = await readRunRecords(deps.fs, outDir, logger);
  if (records.length === 0) {
    io.stderr.write(`bdiff: no run records in ${path.join(outDir, 'runs')}\n`);
    return EXIT_CODES.failed;
  }
  const result = computeStats(records, config.by);
  const outputs = createOutputPaths(outDir);
  await deps.fs.writeFile(outputs.statsJson, `${JSON.stringify(result, null, 2)}\n`);
  // One index over every counted run: a batch run in shards is combined here.
  const counted = countedRecords(records).sort((a, b) => {
    const [x, y] = [a.dataset?.id ?? '', b.dataset?.id ?? ''];
    return x < y ? -1 : x > y ? 1 : a.runId < b.runId ? -1 : 1;
  });
  await writeRunsIndex(deps.fs, outputs.batchIndexHtml, outDir, counted);
  if (config.markdownFile !== undefined) {
    await deps.fs.writeFile(
      path.resolve(deps.cwd, config.markdownFile),
      formatStatsMarkdown(result),
    );
  }
  io.stdout.write(formatStats(result));
  if (unreadable.length > 0) {
    io.stdout.write(`(${String(unreadable.length)} unreadable run.json skipped)\n`);
  }
  io.stdout.write(`stats: ${outputs.statsJson}\n  index: ${outputs.batchIndexHtml}\n`);
  return EXIT_CODES.success;
}

function usage(io: CliIo, command: string, error: unknown): number {
  io.stderr.write(`bdiff: ${describe(error)}\nRun "bdiff ${command} --help" for usage.\n`);
  return EXIT_CODES.usage;
}

/** Files of a finished run that {@link summarize} points to. */
export interface RunFiles {
  readonly runJsonPath: string;
  /** Absent when no report was written. */
  readonly reportPath?: string;
}

/**
 * One short, human-readable summary of a finished run: outcome, findings by severity, duration,
 * LLM cost, and where the report and record are. Pure.
 */
export function summarize(result: RunResult, files: RunFiles): string {
  const { record, findings = [] } = result;
  const outcome =
    record.status === 'failed'
      ? `failed at ${record.failure.stage ?? 'startup'} (${record.failure.code}): ${record.failure.message}`
      : record.status === 'skipped'
        ? `skipped: ${record.skip.reason}`
        : `success, ${findingCounts(findings)}`;
  const lines = [`bdiff: ${outcome}`];
  if (record.status === 'failed' && findings.length > 0) {
    // The report still shows what a run found before it failed (e.g. at interpret).
    lines.push(`  ${findingCounts(findings)} before the failure`);
  }
  const seconds = (record.durationMs / 1000).toFixed(1);
  lines.push(
    `  ${seconds}s · LLM $${record.totals.llmCostUsd.toFixed(4)} · run ${record.runId}`,
    ...(files.reportPath === undefined ? [] : [`  report: ${files.reportPath}`]),
    `  record: ${files.runJsonPath}`,
  );
  return `${lines.join('\n')}\n`;
}

/** e.g. `3 findings (1 breaking, 2 info)`, most severe first. */
function findingCounts(findings: readonly Finding[]): string {
  const bySeverity = [...SeveritySchema.options]
    .reverse()
    .map((severity) => ({
      severity,
      count: findings.filter((finding) => finding.severity === severity).length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ severity, count }) => `${String(count)} ${severity}`);
  const total = `${String(findings.length)} ${findings.length === 1 ? 'finding' : 'findings'}`;
  return bySeverity.length === 0 ? total : `${total} (${bySeverity.join(', ')})`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
