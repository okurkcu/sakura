import path from 'node:path';

import { buildRequestSet } from './request-set.js';
import { toApiResponse } from './response.js';
import type { FileSystem } from '../../adapters/file-system.js';
import type { HttpClient } from '../../adapters/http.js';
import type { ApiCapture, ApiProbe, ApiRequest, ApiResponse } from '../../domain/api-probe.js';
import type { RunningEnvironment } from '../../domain/environment.js';
import type { ImpactPlan } from '../../domain/impact.js';
import type { ProbeError } from '../../domain/probe-error.js';
import type { Recipe } from '../../domain/recipe.js';
import { ProbeRunSchema } from '../../domain/stage.js';
import type { Workspace } from '../../domain/workspace.js';
import { abortError, throwIfAborted } from '../../errors/abort.js';
import { BdiffError } from '../../errors/bdiff-error.js';
import type { LlmClient } from '../../llm/llm-client.js';
import type { Stage } from '../../pipeline/stage.js';
import { errorSummary } from '../ui/normalize.js';

/** Default budget for one request, reading the response included. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Most bytes of a response body kept; the rest is cut and the body marked `truncated`. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Headers every request carries. No cookies are ever sent. */
export const FIXED_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'bdiff',
  accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
};

/** Dependencies of the API probe stage. */
export interface ApiProbeStageDeps {
  readonly http: HttpClient;
  readonly fs: FileSystem;
  readonly llm: LlmClient;
  readonly requestTimeoutMs?: number;
}

/**
 * The API probe stage: builds the request set (see `buildRequestSet`), then sends every request on
 * `baseA`, then `baseB` (the base app again, to tell noise from change), then `head`, one at a
 * time. Each response, or the error when none arrived, is stored as a capture and as a JSON
 * artifact; a request that fails or times out never stops the stage. Requests only ever go to the
 * app's own origin.
 */
export function createApiProbeStage(
  deps: ApiProbeStageDeps,
): Stage<
  { workspace: Workspace; recipe: Recipe; environment: RunningEnvironment; impact: ImpactPlan },
  ApiProbe
> {
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    name: 'probe-api',
    run: async ({ workspace, recipe, environment, impact }, ctx) => {
      const { requests, notProbed } = await buildRequestSet(
        { impact, workspace, appRoot: recipe.appRoot },
        deps,
        ctx,
      );
      ctx.logger.info('request set built', {
        requests: requests.map((request) => `${request.key} (${request.source})`),
        notProbed: notProbed.map((entry) => entry.endpoint),
      });
      const captures: ApiCapture[] = [];
      for (const probeRun of ProbeRunSchema.options) {
        const origin = environment.sides[probeRun === 'head' ? 'head' : 'base'].url;
        for (const request of requests) {
          throwIfAborted(ctx.signal);
          const artifact = ctx.paths.apiResponse(probeRun, request.key);
          await deps.fs.mkdir(path.dirname(artifact));
          const started = ctx.clock.monotonicMs();
          const outcome = await send(deps.http, request, origin, timeoutMs, ctx.signal);
          const capture: ApiCapture = {
            probeRun,
            requestKey: request.key,
            durationMs: Math.max(0, ctx.clock.monotonicMs() - started),
            artifact,
            ...outcome,
          };
          await deps.fs.writeFile(
            artifact,
            `${JSON.stringify({ ...capture, request }, null, 2)}\n`,
          );
          ctx.logger.info('request sent', {
            probeRun,
            request: request.key,
            status: capture.response?.status ?? null,
            durationMs: capture.durationMs,
            ...(capture.error === undefined ? {} : { error: capture.error.code }),
          });
          captures.push(capture);
        }
      }
      ctx.addCounts({
        endpointsProbed: new Set(requests.map((request) => request.endpoint ?? request.key)).size,
      });
      return { requests, captures, notProbed };
    },
  };
}

/** Sends one request; a missing response becomes a {@link ProbeError}, an abort is rethrown. */
async function send(
  http: HttpClient,
  request: ApiRequest,
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ response: ApiResponse } | { error: ProbeError }> {
  try {
    const raw = await http.request({
      method: request.method,
      url: appUrl(origin, request.path),
      headers: {
        ...FIXED_REQUEST_HEADERS,
        ...request.headers,
        ...(request.body === undefined ? {} : { 'content-type': request.body.contentType }),
      },
      ...(request.body === undefined ? {} : { body: request.body.text }),
      timeoutMs,
      signal,
      maxBodyBytes: MAX_RESPONSE_BYTES,
    });
    return { response: toApiResponse(raw, origin) };
  } catch (error) {
    if (signal.aborted) {
      throw abortError(signal);
    }
    if (!(error instanceof BdiffError) || error.code !== 'HTTP_FAILED') {
      throw error;
    }
    const timedOut = error.details.timedOut === true;
    return {
      error: {
        code: timedOut ? 'PROBE_TIMEOUT' : 'PROBE_FAILED',
        message: errorSummary(
          timedOut
            ? `${error.message}: no response within ${String(timeoutMs)} ms`
            : withCause(error),
          origin,
        ),
      },
    };
  }
}

/**
 * The absolute URL of an app path. Paths are validated to stay on the app; this checks it again,
 * since a request must never leave the app's own origin.
 */
export function appUrl(origin: string, appPath: string): string {
  const base = new URL(origin);
  const url = new URL(appPath, base);
  if (url.origin !== base.origin) {
    throw new BdiffError('INVALID_INPUT', `Request path ${appPath} leaves the app`, {
      details: { path: appPath },
    });
  }
  return url.href;
}

/** The error's message followed by its innermost cause, e.g. `… failed: connect ECONNREFUSED`. */
function withCause(error: Error): string {
  let cause: unknown = error.cause;
  while (cause instanceof Error && cause.cause instanceof Error) {
    cause = cause.cause;
  }
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}
