import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BdiffError, isBdiffError } from '@bdiff/core';
import type { Exec, FileSystem, LlmMode, Logger, RunRecord } from '@bdiff/core';
import { ensureWebBuild, PANEL_PATHS, startPanelServer } from '@bdiff/panel';
import type {
  DockerProbe,
  ExperimentNumbers,
  Leftovers,
  PanelDeps,
  PanelServer,
  SuiteRunner,
} from '@bdiff/panel';

import { computeStats, SUCCESS_THRESHOLDS } from './stats.js';

/** What `bdiff ui` does with side effects, injected so tests can replace it. */
export interface PanelServices {
  /** Builds the web UI if its sources changed since the last build. */
  buildWeb(logger: Logger): Promise<void>;
  start(deps: PanelDeps, port: number): Promise<PanelServer>;
  /** Opens `url` in the default browser. */
  openBrowser(url: string, signal: AbortSignal): Promise<void>;
  /** Whether a process runs (a run in progress, or one that was killed). */
  isAlive(pid: number): boolean;
}

const DOCKER_TIMEOUT_MS = 10_000;
const FIXTURE_BUILD_TIMEOUT_MS = 10 * 60_000;
const SUITE_TIMEOUT_MS = 2 * 60 * 60_000;
/** Time the suite's runs get to clean up (containers, worktrees) after Cancel. */
const SUITE_CLEANUP_GRACE_MS = 3 * 60_000;

/** The real {@link PanelServices}: Vite build, the panel server, `open` / `xdg-open`, `kill(pid, 0)`. */
export function createPanelServices(exec: Exec, fs: FileSystem): PanelServices {
  return {
    buildWeb: async (logger) => {
      await ensureWebBuild({
        fs,
        logger,
        sourceDir: PANEL_PATHS.webSource,
        outDir: PANEL_PATHS.webDist,
        sharedFiles: PANEL_PATHS.sharedSources,
      });
    },
    start: startPanelServer,
    openBrowser: async (url, signal) => {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const result = await exec.run(opener, [url], { timeoutMs: 10_000, signal });
      if (result.exitCode !== 0) {
        throw new BdiffError('EXEC_FAILED', `${opener} exited with ${String(result.exitCode)}`);
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
      }
    },
  };
}

/**
 * Docker through the CLI: `docker info` for the daemon, and bdiff's compose projects (`bdiff-*`)
 * for containers, networks and volumes left behind.
 */
export function createDockerProbe(exec: Exec): DockerProbe {
  const docker = async (args: readonly string[], signal: AbortSignal) =>
    exec.run('docker', args, { timeoutMs: DOCKER_TIMEOUT_MS, signal });
  return {
    status: async (signal) => {
      try {
        return (await docker(['info', '--format', '{{.ServerVersion}}'], signal)).exitCode === 0
          ? 'connected'
          : 'unavailable';
      } catch (error) {
        if (isBdiffError(error) && error.code === 'EXEC_FAILED') {
          return 'unavailable';
        }
        throw error;
      }
    },
    leftovers: async (signal): Promise<Leftovers> => {
      const lists = [
        ['container', ['ps', '-a', '--filter', 'name=bdiff-', '--format', '{{.Names}}']],
        ['network', ['network', 'ls', '--filter', 'name=bdiff-', '--format', '{{.Name}}']],
        ['volume', ['volume', 'ls', '--filter', 'name=bdiff-', '--format', '{{.Name}}']],
      ] as const;
      const items: string[] = [];
      for (const [kind, args] of lists) {
        const result = await docker(args, signal);
        if (result.exitCode !== 0) {
          return { status: 'unknown', reason: `docker ${args[0]} failed: ${result.stderr.trim()}` };
        }
        items.push(
          ...result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('bdiff-'))
            .map((name) => `${kind} ${name}`),
        );
      }
      return items.length === 0 ? { status: 'clean' } : { status: 'leftovers', items };
    },
  };
}

/** Inputs of {@link createSuiteRunner}. */
export interface SuiteRunnerOptions {
  readonly exec: Exec;
  /** The bdiff checkout. */
  readonly repoRoot: string;
  /** Where the runs are recorded (the panel's workspace). */
  readonly workspace: string;
  readonly llmMode: LlmMode;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The fixture suite as two child processes of the bdiff checkout: `fixtures/fixture-dataset.ts`
 * builds the fixture repository and its dataset in a new temp directory, then `bdiff batch --force`
 * runs every branch into the workspace. Cancelling sends Ctrl+C (SIGINT), so runs clean up and
 * are recorded as `ABORTED`. The fixture repository stays in the temp directory, so the re-run
 * commands the panel shows keep working.
 */
export function createSuiteRunner(options: SuiteRunnerOptions): SuiteRunner {
  const { exec, repoRoot } = options;
  const tsx = ['--conditions=bdiff-source', '--import', 'tsx'];
  return {
    run: async (signal) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'bdiff-suite-'));
      const built = await exec.run(
        process.execPath,
        [...tsx, path.join(repoRoot, 'fixtures', 'fixture-dataset.ts'), dir],
        {
          cwd: repoRoot,
          timeoutMs: FIXTURE_BUILD_TIMEOUT_MS,
          signal,
          stopSignal: 'SIGINT',
          killGraceMs: 30_000,
        },
      );
      if (built.exitCode !== 0) {
        throw new BdiffError('INTERNAL', 'The fixture repository could not be built', {
          details: { exitCode: built.exitCode, stderrTail: built.stderr.slice(-2_000) },
        });
      }
      const key = options.env.ANTHROPIC_API_KEY;
      const batch = await exec.run(
        process.execPath,
        [
          ...tsx,
          path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts'),
          'batch',
          path.join(dir, 'dataset.json'),
          '--force',
          '--out',
          options.workspace,
          '--llm',
          options.llmMode,
        ],
        {
          cwd: repoRoot,
          timeoutMs: SUITE_TIMEOUT_MS,
          signal,
          stopSignal: 'SIGINT',
          killGraceMs: SUITE_CLEANUP_GRACE_MS,
          // Passed on only when the runs use the model.
          ...(options.llmMode === 'on' && key !== undefined
            ? { env: { ANTHROPIC_API_KEY: key } }
            : {}),
        },
      );
      if (batch.exitCode !== 0) {
        throw new BdiffError('INTERNAL', `bdiff batch exited with ${String(batch.exitCode)}`, {
          details: { exitCode: batch.exitCode, stderrTail: batch.stderr.slice(-2_000) },
        });
      }
    },
  };
}

/** The metric cards' numbers, as `bdiff stats` computes them. Pure. */
export function experimentNumbers(records: readonly RunRecord[]): ExperimentNumbers {
  const { overall } = computeStats(records);
  return {
    setup: overall.setup,
    durationMs: { count: overall.durationMs.count, median: overall.durationMs.median },
    llmCostUsd: { count: overall.llmCostUsd.count, median: overall.llmCostUsd.median },
    targets: {
      setupRate: SUCCESS_THRESHOLDS.setupRate,
      medianDurationMs: SUCCESS_THRESHOLDS.medianDurationMs,
    },
  };
}
