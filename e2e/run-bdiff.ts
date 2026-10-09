import { EventEmitter } from 'node:events';

import { createDefaultCliDeps, runCli } from '@bdiff/cli';
import type { CliDeps, CliIo } from '@bdiff/cli';
import { loadLlmConfig, loadPricingTable, nodeFileSystem } from '@bdiff/core';
import type { LlmClient, LlmTier, PipelineStages } from '@bdiff/core';
import { createTestLogger } from '@bdiff/core/testing';

/** What `bdiff run` printed and returned. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Inputs of {@link runBdiff}. */
export interface RunBdiffOptions {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly outDir: string;
  readonly cacheDir: string;
  /** Working directory of the run. */
  readonly cwd: string;
  /** Replaces the real LLM client; tests never call the real API. */
  readonly llm: LlmClient;
  /** Changes the real stages before the run, e.g. to observe one. */
  readonly editStages?: (stages: PipelineStages) => PipelineStages;
}

/**
 * Runs `bdiff run` in process with the CLI's real adapters and stages (`createDefaultCliDeps`);
 * only the LLM is replaced. Logs go to a test logger. Returns what the CLI printed and its exit code.
 */
export async function runBdiff(options: RunBdiffOptions): Promise<CliRun> {
  const env = { BDIFF_CACHE_DIR: options.cacheDir, BDIFF_TOOL_VERSION: 'test' };
  const real = createDefaultCliDeps(env);
  const deps: CliDeps = {
    ...real,
    cwd: options.cwd,
    createLogger: () => createTestLogger(),
    createStages: (services) => {
      const stages = real.createStages({ ...services, llm: options.llm });
      return options.editStages === undefined ? stages : options.editStages(stages);
    },
  };
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env,
    signals: new EventEmitter(),
    forceExit: (code) => {
      throw new Error(`unexpected forced exit ${String(code)}`);
    },
  };
  const exitCode = await runCli(
    [
      'run',
      '--repo',
      options.repo,
      '--base',
      options.base,
      '--head',
      options.head,
      '--out',
      options.outDir,
    ],
    io,
    deps,
  );
  return { exitCode, stdout, stderr };
}

/**
 * The configured model of each tier (`config/llm.json`), so a fake LLM's usage is priced from the
 * real pricing table like a real call's.
 */
export async function configuredModels(): Promise<Record<LlmTier, string>> {
  const { llmConfigPath, pricingPath } = createDefaultCliDeps({});
  const { tiers } = await loadLlmConfig(
    nodeFileSystem,
    llmConfigPath,
    await loadPricingTable(nodeFileSystem, pricingPath),
  );
  return { fast: tiers.fast.model, smart: tiers.smart.model };
}
