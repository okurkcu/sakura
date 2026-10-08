import path from 'node:path';

import type { ImportGraph } from './import-graph.js';
import type { Route } from '../domain/impact.js';

/** Routes a set of changed files can affect, and the changed files that reach no route. */
export interface AffectedRoutes {
  readonly affected: Route[];
  readonly unmappedFiles: string[];
}

const LAYOUT_NAMES = new Set(['layout', 'template']);

/**
 * Maps changed runtime files to the routes they can affect, by walking the import graph backwards
 * from each file to the route files that (transitively) import it. A reached App Router
 * `layout`/`template` affects every page in its directory and below (so a global CSS file
 * imported by the root layout affects all pages); a reached Pages Router `_app`/`_document`
 * affects every Pages Router page. A changed file that is itself a route file maps to that route
 * (including routes that exist only in base, e.g. deleted pages). Pure.
 */
export function affectedRoutes(
  changed: readonly string[],
  routes: readonly Route[],
  graph: ImportGraph,
): AffectedRoutes {
  const importers = new Map<string, string[]>();
  for (const [source, dependencies] of graph) {
    for (const dependency of dependencies) {
      importers.set(dependency, [...(importers.get(dependency) ?? []), source]);
    }
  }
  const routesByFile = new Map<string, Route[]>();
  for (const route of routes) {
    routesByFile.set(route.file, [...(routesByFile.get(route.file) ?? []), route]);
  }

  const affected = new Map<string, Route>();
  const unmappedFiles: string[] = [];
  for (const file of changed) {
    const found = routesReachedFrom(file, importers, routesByFile, routes);
    if (found.length === 0) {
      unmappedFiles.push(file);
    }
    for (const route of found) {
      affected.set(routeKey(route), route);
    }
  }
  return {
    affected: [...affected.values()].sort(compareRoutes),
    unmappedFiles: unmappedFiles.sort(),
  };
}

function routesReachedFrom(
  start: string,
  importers: ReadonlyMap<string, readonly string[]>,
  routesByFile: ReadonlyMap<string, readonly Route[]>,
  routes: readonly Route[],
): Route[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  const found: Route[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    found.push(...(routesByFile.get(file) ?? []), ...sharedShellRoutes(file, routes));
    for (const importer of importers.get(file) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return found;
}

/** Pages under an App Router layout/template, or all Pages Router pages for `_app`/`_document`. */
function sharedShellRoutes(file: string, routes: readonly Route[]): Route[] {
  const name = path.posix.basename(file, path.posix.extname(file));
  const dir = path.posix.dirname(file);
  if (LAYOUT_NAMES.has(name) && /(^|\/)app(\/|$)/.test(dir)) {
    return routes.filter((route) => route.kind === 'page' && route.file.startsWith(`${dir}/`));
  }
  if ((name === '_app' || name === '_document') && /(^|\/)pages$/.test(dir)) {
    return routes.filter((route) => route.kind === 'page' && route.file.startsWith(`${dir}/`));
  }
  return [];
}

/** Identity of a route: method and path. */
export function routeKey(route: Route): string {
  return route.method === undefined ? route.path : `${route.method} ${route.path}`;
}

/** Order routes by path, then method. */
export function compareRoutes(a: Route, b: Route): number {
  return a.path.localeCompare(b.path) || (a.method ?? '').localeCompare(b.method ?? '');
}
