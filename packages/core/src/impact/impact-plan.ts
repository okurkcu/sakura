import { compareRoutes } from './impact-mapping.js';
import type { ImpactPlan, Route } from '../domain/impact.js';

/** How many routes of each kind a run probes at most. */
export interface ImpactLimits {
  readonly maxPages: number;
  readonly maxEndpoints: number;
}

/** Defaults: 10 pages and 10 endpoints. */
export const DEFAULT_IMPACT_LIMITS: ImpactLimits = { maxPages: 10, maxEndpoints: 10 };

const FALLBACK_TOP_LEVEL_PAGES = 3;

/** Inputs of {@link buildImpactPlan}. */
export interface ImpactPlanInput {
  /** Every route of the app (head, plus routes that only exist in base). */
  readonly routes: readonly Route[];
  /** Routes the changed files can affect. */
  readonly affected: readonly Route[];
  readonly unmappedFiles: readonly string[];
  readonly limits: ImpactLimits;
  readonly notes?: readonly string[];
}

/**
 * Decides what to probe. Affected dynamic routes are listed as not probed (`dynamic-params`);
 * beyond the per-kind limits, routes are listed as not probed (`cap`). If nothing maps, the plan
 * falls back to `/` plus up to three top-level static pages with `low` confidence; if some files
 * don't map, confidence is `medium`. Pure.
 */
export function buildImpactPlan(input: ImpactPlanInput): ImpactPlan {
  const notes = [...(input.notes ?? [])];
  let candidates = [...input.affected].sort(compareRoutes);
  let confidence: ImpactPlan['confidence'] = input.unmappedFiles.length > 0 ? 'medium' : 'high';
  if (candidates.length === 0) {
    const staticPages = input.routes.filter((route) => route.kind === 'page' && !route.dynamic);
    const home = staticPages.filter((route) => route.path === '/');
    const topLevel = staticPages
      .filter((route) => route.path !== '/' && route.path.split('/').length === 2)
      .sort(compareRoutes)
      .slice(0, FALLBACK_TOP_LEVEL_PAGES);
    candidates = [...home, ...topLevel];
    confidence = 'low';
    notes.push(
      input.unmappedFiles.length > 0
        ? `no route depends on the changed files (${input.unmappedFiles.join(', ')}); probing a fallback set of pages`
        : 'no route depends on the changed files; probing a fallback set of pages',
    );
  }

  const notProbed: ImpactPlan['notProbed'] = [];
  const pick = (kind: Route['kind'], limit: number): Route[] => {
    const chosen: Route[] = [];
    for (const route of candidates.filter((candidate) => candidate.kind === kind)) {
      if (route.dynamic) {
        notProbed.push({ route, reason: 'dynamic-params' });
      } else if (chosen.length >= limit) {
        notProbed.push({ route, reason: 'cap' });
      } else {
        chosen.push(route);
      }
    }
    return chosen;
  };
  const pages = pick('page', input.limits.maxPages);
  const endpoints = pick('api', input.limits.maxEndpoints);
  return {
    pages,
    endpoints,
    notProbed,
    confidence,
    unmappedFiles: [...input.unmappedFiles],
    notes,
  };
}
