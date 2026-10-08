import { constants } from 'node:os';

import { execa } from 'execa';

import { execFailedError, execTimeoutError } from './exec.js';
import type { Exec, ExecOptions, ExecResult } from './exec.js';
import { SECRET_ENV_VARS } from './secrets.js';
import { abortError, throwIfAborted } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Time a process group gets to exit after SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 2_000;

/** Process groups started by this module that are still running. */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * Real {@link Exec} backed by execa. Each command runs as the leader of its own process group, so
 * a timeout or abort kills the whole tree (children and grandchildren), not just the direct child.
 * Any group still running when the bdiff process exits is killed too.
 *
 * POSIX only (macOS, Linux): process groups don't exist on Windows.
 */
export function createExecaExec(): Exec {
  installExitHook();
  return { run };
}

async function run(
  cmd: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  throwIfAborted(options.signal);

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const stopSignal = AbortSignal.any([options.signal, timeoutSignal]);

  const subprocess = execa(cmd, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: childEnvironment(options.env),
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    detached: true,
  });

  const { pid } = subprocess;
  /** Unexpected errors from signalling the process group; reported once the command ends. */
  const killErrors: unknown[] = [];
  const kill = (signal: NodeJS.Signals) => {
    if (pid !== undefined) {
      const error = tryKillProcessGroup(pid, signal);
      if (error !== undefined) {
        killErrors.push(error);
      }
    }
  };
  let graceTimer: NodeJS.Timeout | undefined;
  // Runs inside an event dispatch: it must never throw, or the whole process would crash.
  const stop = () => {
    kill('SIGTERM');
    graceTimer = setTimeout(() => {
      kill('SIGKILL');
    }, KILL_GRACE_MS);
  };

  if (pid !== undefined) {
    liveProcessGroups.add(pid);
  }
  stopSignal.addEventListener('abort', stop, { once: true });

  try {
    const result = await subprocess;
    if (stopSignal.aborted) {
      // The direct child is gone; make sure nothing it spawned outlives it.
      kill('SIGKILL');
    }

    if (killErrors.length > 0) {
      throw new BdiffError('EXEC_FAILED', `Could not stop the processes of: ${cmd}`, {
        cause: killErrors[0],
        details: { cmd, args: [...args] },
      });
    }
    if (options.signal.aborted) {
      throw abortError(options.signal);
    }
    if (timeoutSignal.aborted) {
      throw execTimeoutError(cmd, args, options.timeoutMs, result.stderr);
    }
    if (result.exitCode === undefined && result.signal === undefined) {
      throw execFailedError(cmd, args, result.cause ?? result.originalMessage);
    }
    return {
      exitCode: result.exitCode ?? 128 + signalNumber(result.signal),
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.round(result.durationMs),
    };
  } finally {
    stopSignal.removeEventListener('abort', stop);
    clearTimeout(graceTimer);
    if (pid !== undefined) {
      liveProcessGroups.delete(pid);
    }
  }
}

/** Parent environment minus bdiff's secrets, plus the caller's additions. */
function childEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const secrets = new Set<string>(SECRET_ENV_VARS);
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !secrets.has(entry[0]),
  );
  return { ...Object.fromEntries(inherited), ...extra };
}

function signalNumber(signal: string | undefined): number {
  const signals: Readonly<Record<string, number>> = constants.signals;
  return (signal === undefined ? undefined : signals[signal]) ?? 0;
}

/**
 * Signals every process in the group led by `pid`. Returns an unexpected error instead of throwing.
 * A group that is already gone is fine: `ESRCH`, or `EPERM`, which macOS returns for a group whose
 * members have all exited but are not reaped yet. Our own children never refuse a signal otherwise.
 */
export function tryKillProcessGroup(pid: number, signal: NodeJS.Signals): unknown {
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (error) {
    return isGroupGone(error) ? undefined : error;
  }
}

function isGroupGone(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'EPERM')
  );
}

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const pid of liveProcessGroups) {
      // The process is exiting: there is nobody left to report a failed kill to.
      tryKillProcessGroup(pid, 'SIGKILL');
    }
  });
}
