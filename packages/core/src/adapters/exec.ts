import { BdiffError } from '../errors/bdiff-error.js';

/** Options for {@link Exec.run}. Timeout and abort signal are mandatory by design. */
export interface ExecOptions {
  /** Working directory; defaults to the current one. */
  readonly cwd?: string;
  /**
   * Extra environment variables, merged over the parent environment. bdiff's own secrets
   * (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) are not inherited; pass them here explicitly if a
   * command really needs one.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** The process tree is killed and `EXEC_TIMEOUT` thrown when this elapses. */
  readonly timeoutMs: number;
  /** Aborting kills the process tree and rejects with the abort error. */
  readonly signal: AbortSignal;
}

/** Outcome of a command that ran to completion. A non-zero exit code is not an error. */
export interface ExecResult {
  /** Exit code; `128 + signal number` if the process was killed by a signal it didn't get from us. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/**
 * Runs host commands (git, docker). Never use it to run target-repo code: that only ever runs
 * inside containers.
 */
export interface Exec {
  /**
   * Runs `cmd` with `args` (no shell, so arguments are never interpolated) and waits for it.
   * Never put secrets in `args`; they end up in error details and logs. Pass them via `env`.
   *
   * @throws BdiffError `EXEC_TIMEOUT` when `timeoutMs` elapses, `EXEC_FAILED` when the command
   *   cannot be started, or the abort error of `signal`.
   */
  run(cmd: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

/** Last lines of stderr kept in error details. */
const STDERR_TAIL_LINES = 20;

/** Builds the error thrown when a command exceeds its timeout. Shared by real and fake exec. */
export function execTimeoutError(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
  stderr = '',
): BdiffError {
  return new BdiffError('EXEC_TIMEOUT', `Command timed out after ${String(timeoutMs)} ms: ${cmd}`, {
    details: { cmd, args: [...args], timeoutMs, stderrTail: tailLines(stderr, STDERR_TAIL_LINES) },
  });
}

/** Builds the error thrown when a command cannot be started (e.g. not installed). */
export function execFailedError(cmd: string, args: readonly string[], cause: unknown): BdiffError {
  return new BdiffError('EXEC_FAILED', `Command could not be started: ${cmd}`, {
    cause,
    details: { cmd, args: [...args] },
  });
}

function tailLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}
