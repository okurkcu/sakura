import type { Exec, ExecResult } from '../adapters/exec.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Default timeout of a local git command. */
export const GIT_LOCAL_TIMEOUT_MS = 60_000;

/**
 * Environment of every git call: never prompt for credentials, never download LFS objects, and
 * only speak https or local repositories (some transports, like `ext::`, run arbitrary commands).
 */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_ALLOW_PROTOCOL: 'file:https',
} as const;

/** Config overrides of every git call: no user hooks, raw (unquoted) paths, quiet detached HEADs. */
const GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.quotePath=false',
  '-c',
  'advice.detachedHead=false',
];

/** Options for one git call. */
export interface GitCallOptions {
  /** Repository or working directory to run in. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Runs git with bdiff's isolated settings. */
export interface Git {
  /** Runs git and returns the result, whatever the exit code. */
  run(args: readonly string[], options?: GitCallOptions): Promise<ExecResult>;
  /**
   * Runs git and returns trimmed stdout.
   *
   * @throws BdiffError `GIT_FAILED` on a non-zero exit, with stderr in the details.
   */
  ok(args: readonly string[], options?: GitCallOptions): Promise<string>;
}

/** Creates a {@link Git} whose calls all respect `signal`. */
export function createGit(exec: Exec, signal: AbortSignal): Git {
  const run: Git['run'] = (args, options = {}) =>
    exec.run('git', [...GIT_CONFIG, ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: GIT_ENV,
      timeoutMs: options.timeoutMs ?? GIT_LOCAL_TIMEOUT_MS,
      signal,
    });
  return {
    run,
    ok: async (args, options) => {
      const result = await run(args, options);
      if (result.exitCode !== 0) {
        throw new BdiffError(
          'GIT_FAILED',
          `git ${args[0] ?? ''} failed: ${firstLine(result.stderr)}`,
          {
            details: {
              args: [...args],
              exitCode: result.exitCode,
              stderr: result.stderr.slice(-2_000),
            },
          },
        );
      }
      return result.stdout.trim();
    },
  };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
