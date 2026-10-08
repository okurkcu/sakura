import { SETUP_EXIT_CODES } from './app-script.js';
import type { Side } from '../domain/stage.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { ErrorCode } from '../errors/codes.js';

/** Log lines kept in a setup failure's details (and so in `run.json`). */
export const LOG_TAIL_LINES = 100;

/** Last `count` non-empty lines of a log. Pure. */
export function tailLines(log: string, count = LOG_TAIL_LINES): string[] {
  return log
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-count);
}

/**
 * The error for an app container that exited during setup: the exit code says which phase
 * failed (see `SETUP_EXIT_CODES`); anything else means the started app died. Pure.
 */
export function setupFailure(side: Side, exitCode: number, log: string): BdiffError {
  const byCode: Readonly<Record<number, readonly [ErrorCode, string]>> = {
    [SETUP_EXIT_CODES.toolchain]: ['SETUP_INSTALL_FAILED', 'could not prepare the package manager'],
    [SETUP_EXIT_CODES.install]: ['SETUP_INSTALL_FAILED', 'dependency install failed'],
    [SETUP_EXIT_CODES.db]: ['SETUP_DB_FAILED', 'database setup failed'],
    [SETUP_EXIT_CODES.build]: ['SETUP_BUILD_FAILED', 'build failed'],
  };
  const [code, what] = byCode[exitCode] ?? [
    'SETUP_START_FAILED',
    `app exited after start (exit code ${String(exitCode)})`,
  ];
  return new BdiffError(code, `${side}: ${what}`, {
    details: { side, exitCode, logTail: tailLines(log) },
  });
}

/** The error for an app that never answered its health check in time. Pure. */
export function setupTimeout(side: Side, timeoutMs: number, log: string): BdiffError {
  return new BdiffError(
    'SETUP_TIMEOUT',
    `${side}: app was not healthy within ${String(Math.round(timeoutMs / 1000))} s`,
    {
      details: { side, timeoutMs, logTail: tailLines(log) },
    },
  );
}
