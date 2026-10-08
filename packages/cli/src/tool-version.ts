import type { Exec, Logger } from '@bdiff/core';

/** Inputs for {@link resolveToolVersion}. */
export interface ToolVersionOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec: Exec;
  /** A directory inside the bdiff checkout. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

const GIT_TIMEOUT_MS = 10_000;

/**
 * The version recorded in every run record: `BDIFF_TOOL_VERSION` or `GITHUB_SHA` if set, else the
 * git SHA of the bdiff checkout with a `-dirty` suffix when it has uncommitted changes, else
 * `unknown` (with a warning; the run still proceeds).
 */
export async function resolveToolVersion(options: ToolVersionOptions): Promise<string> {
  const fromEnv = options.env.BDIFF_TOOL_VERSION ?? options.env.GITHUB_SHA;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  const git = (args: readonly string[]) =>
    options.exec.run('git', args, {
      cwd: options.cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      signal: options.signal,
    });
  try {
    const head = await git(['rev-parse', 'HEAD']);
    const status = await git(['status', '--porcelain']);
    if (head.exitCode !== 0 || status.exitCode !== 0) {
      options.logger.warn('could not read the bdiff git SHA; recording toolVersion "unknown"', {
        stderr: head.stderr || status.stderr,
      });
      return 'unknown';
    }
    const sha = head.stdout.trim();
    return status.stdout.trim() === '' ? sha : `${sha}-dirty`;
  } catch (error) {
    options.logger.warn('could not run git; recording toolVersion "unknown"', { err: error });
    return 'unknown';
  }
}
