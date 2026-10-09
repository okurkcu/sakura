import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { BdiffError, isBdiffError, parseRunEvents, RunIdSchema } from '@bdiff/core';
import type { Clock, FileSystem, LlmMode, Logger, RunRecord } from '@bdiff/core';

import type {
  DockerStatus,
  FixtureResponse,
  RunDetailResponse,
  RunsResponse,
  StatusResponse,
  SuiteJob,
} from '../api.js';
import { contentTypeOf, resolveRunFile } from './artifacts.js';
import { checkFixture, ExpectedFixtureSchema } from './fixture-check.js';
import type { FixtureRun, Leftovers } from './fixture-check.js';
import { loadRun, loadRuns } from './read-runs.js';
import type { RunSource } from './run-source.js';
import { buildMetrics, newestFirst, summarizeRun } from './runs.js';
import type { ExperimentNumbers } from './runs.js';

/** The only address the panel listens on: it serves local files and must not be reachable remotely. */
export const PANEL_HOST = '127.0.0.1';
/** Default port of `bdiff ui`. */
export const DEFAULT_PANEL_PORT = 4317;

/** Docker, as far as the panel needs it. */
export interface DockerProbe {
  /** Whether the daemon answers. */
  status(signal: AbortSignal): Promise<DockerStatus>;
  /** bdiff containers, networks or volumes still present. */
  leftovers(signal: AbortSignal): Promise<Leftovers>;
}

/** Starts the fixture suite (build the fixture repository, run every branch) and waits for it. */
export interface SuiteRunner {
  /**
   * Runs the suite to the end. Aborting `signal` stops it the way Ctrl+C would (the runs clean up
   * and are recorded as `ABORTED`).
   */
  run(signal: AbortSignal): Promise<void>;
}

/** What the panel server needs; the CLI composition root builds it. */
export interface PanelDeps {
  readonly source: RunSource;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Serving demo data (`--demo`). */
  readonly demo: boolean;
  readonly toolVersion: string;
  /** The LLM mode a run started now would get. */
  readonly llmMode: LlmMode;
  /** Directory of the built web UI (`index.html` and its assets). */
  readonly webRoot: string;
  /** `fixtures/expected.json`; the fixture check is unavailable without it. */
  readonly expectedFile?: string;
  readonly docker: DockerProbe;
  /** The experiment's numbers over finished runs, as `bdiff stats` computes them. */
  readonly experiment: (records: readonly RunRecord[]) => ExperimentNumbers;
  /** Runs the fixture suite; absent when it cannot run here (demo). */
  readonly suite?: SuiteRunner;
  /** How often a live event stream checks `events.jsonl` for new lines. */
  readonly pollMs?: number;
}

/** A running panel server. */
export interface PanelServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** Stops accepting connections, ends open event streams and stops a running suite. */
  close(): Promise<void>;
}

const DEFAULT_POLL_MS = 250;
const HEARTBEAT_MS = 15_000;
const DOCKER_CACHE_MS = 10_000;
const DOCKER_TIMEOUT_MS = 10_000;

const APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
/** The report's own policy (it is self-contained), sent as a header too. */
const REPORT_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'";

const WEB_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

/** Thrown by a handler to answer with an HTTP error. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Starts the panel's HTTP server on `127.0.0.1:<port>` (0 picks a free port). It serves the web
 * UI, a JSON API over the runs of `deps.source`, live run events (Server-Sent Events), and run
 * files read-only. Requests must name the panel itself as `Host` (no DNS rebinding) and state-
 * changing ones must come from its own origin.
 *
 * @throws BdiffError `INVALID_INPUT` when the port is taken or not allowed.
 */
export async function startPanelServer(deps: PanelDeps, port: number): Promise<PanelServer> {
  const shutdown = new AbortController();
  const app = createPanelHandler(deps, shutdown.signal, () => actualPort);
  const server = createServer((req, res) => {
    app(req, res).catch((error: unknown) => {
      deps.logger.error('panel request failed', { url: req.url, err: error });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' });
      } else {
        res.end();
      }
    });
  });
  let actualPort = port;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        new BdiffError(
          'INVALID_INPUT',
          `The panel cannot listen on ${PANEL_HOST}:${String(port)}`,
          {
            cause: error,
            details: { port },
          },
        ),
      );
    });
    server.listen(port, PANEL_HOST, () => {
      resolve();
    });
  });
  actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://${PANEL_HOST}:${String(actualPort)}`,
    port: actualPort,
    close: () => closeServer(server, shutdown),
  };
}

function closeServer(server: Server, shutdown: AbortController): Promise<void> {
  shutdown.abort(new BdiffError('ABORTED', 'The panel is shutting down'));
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections();
  });
}

/** The request handler; exported for tests through {@link startPanelServer}. */
function createPanelHandler(
  deps: PanelDeps,
  shutdown: AbortSignal,
  port: () => number,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let dockerCache: { at: number; status: DockerStatus } | undefined;
  let suite: { job: SuiteJob; controller: AbortController } | undefined;

  const dockerStatus = async (): Promise<DockerStatus> => {
    const now = deps.clock.monotonicMs();
    if (dockerCache !== undefined && now - dockerCache.at < DOCKER_CACHE_MS) {
      return dockerCache.status;
    }
    const status = await withTimeout(deps.clock, DOCKER_TIMEOUT_MS, shutdown, (signal) =>
      deps.docker.status(signal),
    ).catch((error: unknown) => {
      deps.logger.warn('docker status unknown', { err: error });
      return 'unknown' as const;
    });
    dockerCache = { at: now, status };
    return status;
  };

  const handlers: Record<
    string,
    (req: IncomingMessage, res: ServerResponse, parts: string[]) => Promise<void>
  > = {
    'GET status': async (_req, res) => {
      const body: StatusResponse = {
        demo: deps.demo,
        workspace: deps.source.root,
        toolVersion: deps.toolVersion,
        llmMode: deps.llmMode,
        docker: deps.demo ? 'unknown' : await dockerStatus(),
        canRunSuite: deps.suite !== undefined && deps.expectedFile !== undefined,
        suite: suite?.job ?? null,
      };
      sendJson(res, 200, body);
    },
    'GET runs': async (_req, res) => {
      const runs = await loadRuns(deps.source, deps.logger);
      const now = deps.clock.now();
      const summaries = runs.flatMap((run) => {
        const summary = summarizeRun(run, now, (pid) => deps.source.isAlive(pid));
        return summary === undefined ? [] : [summary];
      });
      const records = runs.flatMap((run) => (run.record === undefined ? [] : [run.record]));
      const body: RunsResponse = {
        runs: newestFirst(summaries),
        metrics: buildMetrics(deps.experiment(records), records),
        unreadable: runs.filter((run) => run.unreadable).length,
      };
      sendJson(res, 200, body);
    },
    'GET run': async (_req, res, [runId = '']) => {
      const run = await loadRun(deps.source, validRunId(runId), deps.logger, true);
      const summary = summarizeRun(run, deps.clock.now(), (pid) => deps.source.isAlive(pid));
      if (summary === undefined) {
        throw new HttpError(404, `No run ${runId}`);
      }
      const body: RunDetailResponse = {
        summary,
        events: run.events,
        files: (await deps.source.listFiles(runId)).filter(
          (file) => contentTypeOf(file) !== undefined,
        ),
        ...(run.record === undefined ? {} : { record: run.record }),
        ...(run.result === undefined ? {} : { result: run.result }),
      };
      sendJson(res, 200, body);
    },
    'GET run-events': async (req, res, [runId = '']) => {
      await streamEvents(req, res, validRunId(runId));
    },
    'GET run-file': async (_req, res, [runId = '', ...rest]) => {
      const relative = rest.join('/');
      const type = contentTypeOf(relative);
      if (
        type === undefined ||
        resolveRunFile('/runs', validRunId(runId), relative) === undefined
      ) {
        throw new HttpError(404, 'Not a file the panel serves');
      }
      const bytes = await deps.source.readBytes(runId, relative);
      if (bytes === undefined) {
        throw new HttpError(404, 'No such file');
      }
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': type,
        'Content-Security-Policy': type.startsWith('text/html') ? REPORT_CSP : "default-src 'none'",
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
    },
    'GET fixture': async (_req, res) => {
      sendJson(res, 200, await fixture());
    },
    'POST suite-run': (_req, res) => {
      if (deps.suite === undefined || deps.expectedFile === undefined) {
        throw new HttpError(
          409,
          deps.demo ? 'Not available with demo data' : 'The suite cannot run here',
        );
      }
      if (suite?.job.state === 'running') {
        throw new HttpError(409, 'The suite is already running');
      }
      const controller = new AbortController();
      const job: { -readonly [K in keyof SuiteJob]: SuiteJob[K] } = {
        state: 'running',
        startedAt: deps.clock.now().toISOString(),
      };
      const stop = () => {
        controller.abort(shutdown.reason);
      };
      shutdown.addEventListener('abort', stop, { once: true });
      suite = { job, controller };
      deps.suite
        .run(controller.signal)
        .then(
          () => {
            job.state = controller.signal.aborted ? 'cancelled' : 'finished';
          },
          (error: unknown) => {
            job.state = controller.signal.aborted ? 'cancelled' : 'failed';
            if (!controller.signal.aborted) {
              job.message = error instanceof Error ? error.message : String(error);
              deps.logger.error('fixture suite failed', { err: error });
            }
          },
        )
        .finally(() => {
          job.finishedAt = deps.clock.now().toISOString();
          shutdown.removeEventListener('abort', stop);
        });
      sendJson(res, 202, job);
      return Promise.resolve();
    },
    'POST suite-cancel': (_req, res) => {
      if (suite?.job.state !== 'running') {
        throw new HttpError(409, 'No suite is running');
      }
      suite.controller.abort(new BdiffError('ABORTED', 'Cancelled from the panel'));
      sendJson(res, 202, suite.job);
      return Promise.resolve();
    },
  };

  const fixture = async (): Promise<FixtureResponse> => {
    const file = deps.expectedFile;
    if (file === undefined || !(await deps.fs.exists(file))) {
      return { available: false, checks: [], lastRunAt: null };
    }
    const expected = ExpectedFixtureSchema.parse(JSON.parse(await deps.fs.readFile(file)));
    const runs = await loadRuns(deps.source, deps.logger, true);
    const finished: FixtureRun[] = runs.flatMap((run) =>
      run.record === undefined
        ? []
        : [{ record: run.record, ...(run.result === undefined ? {} : { result: run.result }) }],
    );
    const leftovers: Leftovers = deps.demo
      ? { status: 'clean' }
      : (await dockerStatus()) !== 'connected'
        ? { status: 'unknown', reason: 'Docker is not reachable' }
        : await withTimeout(deps.clock, DOCKER_TIMEOUT_MS, shutdown, (signal) =>
            deps.docker.leftovers(signal),
          );
    // A run in progress owns its containers; only those of ended runs are left behind.
    const now = deps.clock.now();
    const running = runs
      .filter(
        (run) => summarizeRun(run, now, (pid) => deps.source.isAlive(pid))?.state === 'running',
      )
      .map((run) => run.runId);
    return checkFixture(expected, finished, withoutRunning(leftovers, running), deps.llmMode);
  };

  const streamEvents = async (req: IncomingMessage, res: ServerResponse, runId: string) => {
    const exists = (await deps.source.listRunIds()).includes(runId);
    if (!exists) {
      throw new HttpError(404, `No run ${runId}`);
    }
    const closed = new AbortController();
    const stop = () => {
      closed.abort(new BdiffError('ABORTED', 'Event stream closed'));
    };
    req.once('close', stop);
    shutdown.addEventListener('abort', stop, { once: true });
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    const resumeFrom = Number(req.headers['last-event-id']);
    let sent = Number.isInteger(resumeFrom) && resumeFrom >= 0 ? resumeFrom + 1 : 0;
    let lastBeat = deps.clock.monotonicMs();
    try {
      while (!closed.signal.aborted) {
        const text = (await deps.source.readText(runId, 'events.jsonl')) ?? '';
        // Only complete lines: the last one may still be being written.
        const lines = text.split('\n').slice(0, -1);
        if (lines.length < sent) {
          res.write('event: reset\ndata: {}\n\n');
          sent = 0;
        }
        let finished = false;
        for (let index = sent; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          const [event] = parseRunEvents(line).events;
          if (event !== undefined) {
            res.write(`id: ${String(index)}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`);
          }
        }
        sent = Math.max(sent, lines.length);
        finished = parseRunEvents(text).events.some((event) => event.type === 'run-finished');
        if (finished && (await deps.source.readText(runId, 'run.json')) !== undefined) {
          res.write('event: end\ndata: {}\n\n');
          break;
        }
        if (deps.clock.monotonicMs() - lastBeat >= HEARTBEAT_MS) {
          res.write(': ping\n\n');
          lastBeat = deps.clock.monotonicMs();
        }
        await deps.clock
          .sleep(deps.pollMs ?? DEFAULT_POLL_MS, closed.signal)
          .catch(() => undefined);
      }
    } finally {
      req.off('close', stop);
      shutdown.removeEventListener('abort', stop);
      res.end();
    }
  };

  return async (req, res) => {
    const allowedHosts = new Set([
      `${PANEL_HOST}:${String(port())}`,
      `localhost:${String(port())}`,
    ]);
    if (!allowedHosts.has(req.headers.host ?? '')) {
      sendJson(res, 403, { error: 'Unexpected Host header' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${PANEL_HOST}`);
    const method = req.method ?? 'GET';
    if (method === 'POST') {
      const origin = req.headers.origin ?? '';
      if (![...allowedHosts].some((host) => origin === `http://${host}`)) {
        sendJson(res, 403, { error: 'Cross-origin request refused' });
        return;
      }
    }
    try {
      const route = matchRoute(method, url.pathname);
      if (route !== undefined) {
        const handler = handlers[route.name];
        if (handler === undefined) {
          throw new HttpError(404, 'Not found');
        }
        await handler(req, res, route.params);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'Not found');
      }
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed');
      }
      await serveWeb(deps, url.pathname, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (isBdiffError(error) && error.code === 'INVALID_INPUT') {
        sendJson(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
  };
}

/** `leftovers` without the resources of runs in progress (compose projects are `bdiff-<runId>`). Pure. */
export function withoutRunning(leftovers: Leftovers, runningIds: readonly string[]): Leftovers {
  if (leftovers.status !== 'leftovers') {
    return leftovers;
  }
  const items = leftovers.items.filter((item) => !runningIds.some((runId) => item.includes(runId)));
  return items.length === 0 ? { status: 'clean' } : { status: 'leftovers', items };
}

/** Matches an API route; `params` are the decoded path parameters. Pure. */
export function matchRoute(
  method: string,
  pathname: string,
): { name: string; params: string[] } | undefined {
  const parts = pathname.split('/').slice(1);
  if (parts[0] !== 'api') {
    return undefined;
  }
  let decoded: string[];
  try {
    decoded = parts.slice(1).map((part) => decodeURIComponent(part));
  } catch {
    // Malformed percent-encoding: no route matches it.
    return { name: 'invalid', params: [] };
  }
  const [first, second, third, ...rest] = decoded;
  if (method === 'GET' && first === 'status' && second === undefined) {
    return { name: 'GET status', params: [] };
  }
  if (method === 'GET' && first === 'fixture' && second === undefined) {
    return { name: 'GET fixture', params: [] };
  }
  if (
    method === 'POST' &&
    first === 'suite' &&
    (second === 'run' || second === 'cancel') &&
    third === undefined
  ) {
    return { name: `POST suite-${second}`, params: [] };
  }
  if (method !== 'GET' || first !== 'runs') {
    return undefined;
  }
  if (second === undefined || second === '') {
    return { name: 'GET runs', params: [] };
  }
  if (third === undefined) {
    return { name: 'GET run', params: [second] };
  }
  if (third === 'events' && rest.length === 0) {
    return { name: 'GET run-events', params: [second] };
  }
  if (third === 'files' && rest.length > 0) {
    return { name: 'GET run-file', params: [second, ...rest] };
  }
  return undefined;
}

function validRunId(runId: string): string {
  if (!RunIdSchema.safeParse(runId).success) {
    throw new HttpError(404, 'Not a run id');
  }
  return runId;
}

async function serveWeb(deps: PanelDeps, pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const ext = path.extname(relative).toLowerCase();
  // Paths without an extension are routes of the single-page app.
  const file = ext === '' ? 'index.html' : relative;
  const type = WEB_TYPES[path.extname(file).toLowerCase()];
  const resolved = resolveRunFile(path.dirname(deps.webRoot), path.basename(deps.webRoot), file);
  if (type === undefined || resolved === undefined || !(await deps.fs.exists(resolved))) {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': type,
    'Content-Security-Policy': APP_CSP,
    'Cache-Control': file === 'index.html' ? 'no-store' : 'max-age=3600',
  });
  res.end(await deps.fs.readFileBytes(resolved));
}

function baseHeaders(): Record<string, string> {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Runs `fn` with a signal that aborts after `ms` or on `outer`. */
async function withTimeout<T>(
  clock: Clock,
  ms: number,
  outer: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stopTimer = new AbortController();
  const onOuter = () => {
    controller.abort(outer.reason);
  };
  outer.addEventListener('abort', onOuter, { once: true });
  clock.sleep(ms, stopTimer.signal).then(
    () => {
      controller.abort(new BdiffError('EXEC_TIMEOUT', `Timed out after ${String(ms)} ms`));
    },
    // Cancelled because `fn` finished first.
    () => undefined,
  );
  try {
    return await fn(controller.signal);
  } finally {
    stopTimer.abort();
    outer.removeEventListener('abort', onOuter);
  }
}
