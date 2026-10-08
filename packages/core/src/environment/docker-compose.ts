import { z } from 'zod';

import type { Exec, ExecResult } from '../adapters/exec.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { ErrorCode } from '../errors/codes.js';

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
/** Creating containers may pull images (node is about 1.6 GB) the first time. */
const CREATE_TIMEOUT_MS = 15 * 60_000;
const COPY_TIMEOUT_MS = 5 * 60_000;
const UP_TIMEOUT_MS = 5 * 60_000;

/** State of one compose service's container. */
export interface ServiceState {
  readonly service: string;
  readonly running: boolean;
  readonly exitCode: number;
}

const PsEntrySchema = z.looseObject({
  Service: z.string(),
  State: z.string(),
  ExitCode: z.number().int(),
});

/** The docker CLI calls of one compose project. Everything runs on the host's docker CLI only. */
export interface ComposeProject {
  /** Fails with `DOCKER_UNAVAILABLE` when the docker daemon can't be reached. */
  checkDocker(): Promise<void>;
  /** Creates containers, networks and volumes without starting them (pulls missing images). */
  create(): Promise<void>;
  /** Copies a host directory's contents into a created container. */
  copyInto(service: string, sourceDir: string, targetDir: string): Promise<void>;
  /** Starts every service, after backing services are healthy. */
  up(): Promise<void>;
  /** Host address of a published container port, e.g. `127.0.0.1:55012`. */
  port(service: string, containerPort: number): Promise<string>;
  states(): Promise<ServiceState[]>;
  logs(service: string): Promise<string>;
  /** Wall-clock seconds the containers of `services` have run so far (or ran, if stopped). */
  runSeconds(services: readonly string[], now: Date): Promise<number>;
  /**
   * Removes containers, networks and volumes of the project, found by project name, so it works
   * even when the compose file was deleted. Safe to call when nothing exists.
   */
  down(signal: AbortSignal): Promise<void>;
}

/** Creates the {@link ComposeProject} for a compose file and project name. */
export function createComposeProject(
  exec: Exec,
  composeFile: string,
  project: string,
  signal: AbortSignal,
): ComposeProject {
  const compose = (args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS, callSignal = signal) =>
    exec.run('docker', ['compose', '--file', composeFile, '--project-name', project, ...args], {
      timeoutMs,
      signal: callSignal,
    });
  const ok = async (args: readonly string[], timeoutMs?: number, code: ErrorCode = 'INTERNAL') => {
    const result = await compose(args, timeoutMs);
    if (result.exitCode !== 0) {
      throw composeError(args, result, code);
    }
    return result.stdout;
  };

  return {
    checkDocker: async () => {
      const result = await exec.run('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 30_000,
        signal,
      });
      if (result.exitCode !== 0) {
        throw new BdiffError(
          'DOCKER_UNAVAILABLE',
          'Docker is not running or not reachable; start Docker and retry',
          {
            details: { stderr: result.stderr.slice(-1_000) },
          },
        );
      }
    },
    create: async () => {
      await ok(
        ['create', '--pull', 'missing', '--quiet-pull'],
        CREATE_TIMEOUT_MS,
        'DOCKER_UNAVAILABLE',
      );
    },
    copyInto: async (service, sourceDir, targetDir) => {
      await ok(['cp', `${sourceDir}/.`, `${service}:${targetDir}`], COPY_TIMEOUT_MS);
    },
    up: async () => {
      const result = await compose(
        ['up', '--detach', '--no-recreate', '--quiet-pull'],
        UP_TIMEOUT_MS,
      );
      if (result.exitCode !== 0) {
        const conflict = /port is already allocated|address already in use/i.test(result.stderr);
        throw composeError(['up'], result, conflict ? 'SETUP_PORT_CONFLICT' : 'INTERNAL');
      }
    },
    port: async (service, containerPort) =>
      (await ok(['port', service, String(containerPort)])).trim(),
    states: async () => {
      const output = await ok(['ps', '--all', '--format', 'json']);
      return parsePs(output).map((entry) => ({
        service: entry.Service,
        running: entry.State === 'running',
        exitCode: entry.ExitCode,
      }));
    },
    logs: async (service) => {
      const result = await compose(['logs', '--no-color', '--no-log-prefix', service]);
      return result.stdout + result.stderr;
    },
    runSeconds: async (services, now) => {
      let total = 0;
      for (const service of services) {
        const ids = (await ok(['ps', '--all', '--quiet', service]))
          .split('\n')
          .filter((id) => id.trim() !== '');
        for (const id of ids) {
          const inspect = await exec.run(
            'docker',
            [
              'inspect',
              '--format',
              '{{.State.StartedAt}} {{.State.FinishedAt}} {{.State.Running}}',
              id,
            ],
            { timeoutMs: 30_000, signal },
          );
          total += containerSeconds(inspect.stdout.trim(), now);
        }
      }
      return Math.round(total * 10) / 10;
    },
    down: async (cleanupSignal) => {
      // By project name only, without --file: removal must work even if the compose file is gone.
      const args = ['down', '--volumes', '--remove-orphans', '--timeout', '5'];
      const result = await exec.run('docker', ['compose', '--project-name', project, ...args], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: cleanupSignal,
      });
      if (result.exitCode !== 0) {
        throw composeError(args, result, 'CLEANUP_FAILED');
      }
    },
  };
}

/** Parses `docker compose ps --format json`: an array or one JSON object per line. Pure. */
export function parsePs(output: string): z.infer<typeof PsEntrySchema>[] {
  const trimmed = output.trim();
  if (trimmed === '') {
    return [];
  }
  const values: unknown[] = trimmed.startsWith('[')
    ? z.array(z.unknown()).parse(JSON.parse(trimmed))
    : trimmed.split('\n').map((line): unknown => JSON.parse(line));
  return values.map((value) => PsEntrySchema.parse(value));
}

/**
 * Seconds between a container's start and its finish (or `now` while it runs), from
 * `"<StartedAt> <FinishedAt> <Running>"`. A container that never started counts zero. Pure.
 */
export function containerSeconds(inspect: string, now: Date): number {
  const [startedAt = '', finishedAt = '', running = 'false'] = inspect.split(' ');
  const started = Date.parse(startedAt);
  if (Number.isNaN(started) || started <= 0) {
    return 0;
  }
  const ended = running === 'true' ? now.getTime() : Date.parse(finishedAt);
  return Number.isNaN(ended) || ended < started ? 0 : (ended - started) / 1000;
}

function composeError(args: readonly string[], result: ExecResult, code: ErrorCode): BdiffError {
  return new BdiffError(
    code,
    `docker compose ${args[0] ?? ''} failed: ${result.stderr.trim().split('\n').at(-1) ?? ''}`,
    {
      details: { args: [...args], exitCode: result.exitCode, stderr: result.stderr.slice(-2_000) },
    },
  );
}
