import path from 'node:path';

import { pagesApiMethods } from './handler-methods.js';
import { loadExplicitRequests } from './requests-file.js';
import type { ExplicitRequest } from './requests-file.js';
import type { FileSystem } from '../../adapters/file-system.js';
import type { ApiNotProbed, ApiRequest } from '../../domain/api-probe.js';
import type { HttpMethod, ImpactPlan, Route } from '../../domain/impact.js';
import type { Workspace } from '../../domain/workspace.js';
import { BdiffError } from '../../errors/bdiff-error.js';
import type { ErrorCode } from '../../errors/codes.js';
import type { LlmCallContext, LlmClient } from '../../llm/llm-client.js';
import { apiRequestsPrompt } from '../../llm/prompts/api-requests.js';
import type { GeneratedRequest } from '../../llm/prompts/api-requests.js';

/** Methods sent straight from the route, without a body: they don't change state. */
const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** LLM failures that leave one endpoint unprobed instead of failing the run. */
const GENERATION_FAILURES: ReadonlySet<ErrorCode> = new Set([
  'LLM_INVALID_OUTPUT',
  'LLM_REFUSED',
  'LLM_UNAVAILABLE',
  'LLM_REQUEST_FAILED',
  'BUDGET_EXCEEDED',
]);

/** Dependencies of {@link buildRequestSet}. */
export interface RequestSetDeps {
  readonly fs: FileSystem;
  readonly llm: LlmClient;
}

/** Inputs of {@link buildRequestSet}. */
export interface RequestSetInput {
  readonly impact: ImpactPlan;
  readonly workspace: Workspace;
  /** App directory, relative to the checkout (from the recipe). */
  readonly appRoot: string;
}

/** The requests to send, in order, and the endpoints left out. */
export interface RequestSet {
  readonly requests: ApiRequest[];
  readonly notProbed: ApiNotProbed[];
}

/** A request before it gets its unique key. */
type Draft = Omit<ApiRequest, 'key'>;

/**
 * Builds the API probe's request set, in send order:
 * 1. `explicit`: the head checkout's `bdiff.requests.json`, in file order;
 * 2. `route`: every safe (GET, HEAD, OPTIONS) endpoint of the impact plan, without a body;
 * 3. `generated`: one or two requests per other endpoint, proposed by the LLM (`fast` tier) from
 *    the handler's source. A Pages Router API handler also gets the methods it checks for.
 * An endpoint the explicit file already covers (same method and path) gets no other request. When
 * the LLM fails (no credentials, budget, invalid answer, refusal), the endpoint is listed in
 * `notProbed` and the rest goes on. Each request gets a unique key such as `POST /api/x #2`.
 */
export async function buildRequestSet(
  input: RequestSetInput,
  deps: RequestSetDeps,
  ctx: LlmCallContext,
): Promise<RequestSet> {
  const explicit = (
    await loadExplicitRequests(deps.fs, input.workspace.headPath, input.appRoot)
  ).map(fromExplicit);
  const covered = new Set(explicit.map((request) => endpointOf(request.method, request.path)));
  const fromRoutes: Draft[] = [];
  const generated: Draft[] = [];
  const notProbed: ApiNotProbed[] = [];

  for (const route of input.impact.endpoints) {
    const source = await readHandler(deps.fs, input.workspace, route.file);
    for (const method of methodsOf(route, source)) {
      const endpoint = `${method} ${route.path}`;
      if (covered.has(endpoint)) {
        continue;
      }
      covered.add(endpoint);
      if (SAFE_METHODS.has(method)) {
        fromRoutes.push({ source: 'route', method, path: route.path, headers: {}, endpoint });
        continue;
      }
      if (source === undefined) {
        notProbed.push({
          endpoint,
          reason: 'generation-failed',
          detail: `${route.file} not found`,
        });
        continue;
      }
      try {
        const answer = await deps.llm.complete(
          apiRequestsPrompt({
            method,
            path: route.path,
            file: route.file,
            router: isPagesApi(route.file) ? 'pages' : 'app',
            source,
          }),
          ctx,
        );
        generated.push(
          ...answer.data.requests.map((request) => fromGenerated(request, method, route.path)),
        );
      } catch (error) {
        if (!(error instanceof BdiffError) || !GENERATION_FAILURES.has(error.code)) {
          throw error;
        }
        ctx.logger.warn('could not generate requests', { endpoint, code: error.code });
        notProbed.push({
          endpoint,
          reason: 'generation-failed',
          detail: `${error.code}: ${error.message}`,
        });
      }
    }
  }
  return { requests: withKeys([...explicit, ...fromRoutes, ...generated]), notProbed };
}

/** The methods to probe on an endpoint: its own, plus those a Pages Router handler checks for. */
function methodsOf(route: Route, source: string | undefined): HttpMethod[] {
  const own = route.method ?? 'GET';
  if (!isPagesApi(route.file) || source === undefined) {
    return [own];
  }
  return [...new Set([own, ...pagesApiMethods(source)])];
}

function isPagesApi(file: string): boolean {
  return /(^|\/)pages\/api\//.test(file);
}

/** The handler's source in head, or in base for a handler deleted in head. */
async function readHandler(
  fs: FileSystem,
  workspace: Workspace,
  file: string,
): Promise<string | undefined> {
  for (const root of [workspace.headPath, workspace.basePath]) {
    const absolute = path.join(root, file);
    if (await fs.exists(absolute)) {
      return fs.readFile(absolute);
    }
  }
  return undefined;
}

function fromExplicit(request: ExplicitRequest): Draft {
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const contentType = headers['content-type'];
  delete headers['content-type'];
  const body =
    request.json !== undefined
      ? { contentType: contentType ?? 'application/json', text: JSON.stringify(request.json) }
      : request.text !== undefined
        ? { contentType: contentType ?? 'text/plain; charset=utf-8', text: request.text }
        : undefined;
  return {
    source: 'explicit',
    method: request.method,
    path: request.path,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(request.description === undefined ? {} : { description: request.description }),
    endpoint: endpointOf(request.method, request.path),
  };
}

function fromGenerated(request: GeneratedRequest, method: HttpMethod, routePath: string): Draft {
  const query = new URLSearchParams(
    request.query.map(({ name, value }): [string, string] => [name, value]),
  );
  const search = query.toString();
  return {
    source: 'generated',
    method,
    path: search === '' ? routePath : `${routePath}?${search}`,
    headers: {},
    ...(request.body === null ? {} : { body: request.body }),
    description: request.description,
    endpoint: `${method} ${routePath}`,
  };
}

/** `METHOD /path`, without the query. */
function endpointOf(method: HttpMethod, appPath: string): string {
  return `${method} ${new URL(appPath, 'http://app.invalid').pathname}`;
}

/** Gives each request a key `METHOD /path?query`, numbered (`#2`, `#3`) when repeated. */
function withKeys(drafts: readonly Draft[]): ApiRequest[] {
  const seen = new Map<string, number>();
  return drafts.map((draft) => {
    const base = `${draft.method} ${draft.path}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: count === 1 ? base : `${base} #${String(count)}`, ...draft };
  });
}
