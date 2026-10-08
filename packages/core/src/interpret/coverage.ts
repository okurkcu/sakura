import type { ApiProbe } from '../domain/api-probe.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { UiCapture } from '../domain/ui-capture.js';
import { routeKey } from '../impact/impact-mapping.js';

/** Something the run could not verify, and why. */
export interface CoverageGap {
  readonly what: string;
  readonly reason: string;
}

/** What a run probed and what it could not verify. */
export interface Coverage {
  /** Pages captured on every probe run. */
  readonly pages: string[];
  /** Endpoints that got requests, e.g. `GET /api/orders/latest`. */
  readonly endpoints: string[];
  readonly gaps: CoverageGap[];
}

const NOT_PROBED_REASONS = {
  'dynamic-params': 'dynamic route, needs parameters bdiff does not have',
  cap: 'over the cap of probed routes',
} as const;

/**
 * What was probed and what was not, from the impact plan and the probes: routes left out by the
 * impact plan, pages or requests whose capture failed, endpoints without a request, and changed
 * files that reach no route. Pure.
 */
export function coverageOf(impact: ImpactPlan, ui: readonly UiCapture[], api: ApiProbe): Coverage {
  const failedPages = unique(
    ui.filter((capture) => capture.error !== undefined).map((capture) => capture.route),
  );
  const pages = unique(ui.map((capture) => capture.route)).filter(
    (route) => !failedPages.includes(route),
  );
  const failedRequests = new Set(
    api.captures
      .filter((capture) => capture.error !== undefined)
      .map((capture) => capture.requestKey),
  );
  const endpoints = unique(
    api.requests
      .filter((request) => !failedRequests.has(request.key))
      .map((request) => request.endpoint ?? `${request.method} ${request.path}`),
  );
  return {
    pages,
    endpoints,
    gaps: [
      ...impact.notProbed.map((entry) => ({
        what: routeKey(entry.route),
        reason: NOT_PROBED_REASONS[entry.reason],
      })),
      ...failedPages.map((route) => ({ what: route, reason: 'the page could not be captured' })),
      ...api.requests
        .filter((request) => failedRequests.has(request.key))
        .map((request) => ({ what: request.key, reason: 'the request got no answer' })),
      ...api.notProbed.map((entry) => ({
        what: entry.endpoint,
        reason: 'no example request could be generated',
      })),
      ...impact.unmappedFiles.map((file) => ({
        what: file,
        reason: 'changed, but reaches no probed route',
      })),
    ],
  };
}

/** Most gaps named in a coverage note; the rest are counted. */
const MAX_NAMED_GAPS = 5;

/** One paragraph about what was and was not verified. Pure. */
export function describeCoverage(coverage: Coverage): string {
  const probed = [
    plural(coverage.pages.length, 'page', coverage.pages),
    plural(coverage.endpoints.length, 'endpoint', coverage.endpoints),
  ].join(' and ');
  if (coverage.gaps.length === 0) {
    return `Probed ${probed}; nothing the change can affect was left out.`;
  }
  const named = coverage.gaps.slice(0, MAX_NAMED_GAPS).map((gap) => `${gap.what} (${gap.reason})`);
  const more = coverage.gaps.length - named.length;
  return `Probed ${probed}. Not verified: ${named.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''}.`;
}

function plural(count: number, noun: string, items: readonly string[]): string {
  const counted = `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
  return count === 0 ? counted : `${counted} (${items.join(', ')})`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
