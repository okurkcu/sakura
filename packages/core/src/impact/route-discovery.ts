import path from 'node:path';

import type { HttpMethod, Route } from '../domain/impact.js';
import type { RepoFiles } from '../recipe/repo-files.js';

const SOURCE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mdx', 'md'];
const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];
const PAGES_SPECIAL = new Set(['_app', '_document', '_error', '404', '500']);

/**
 * Every page and API route of a Next.js app (App Router and Pages Router), from the file list.
 * App Router: `page.*` files are pages, `route.*` files are API routes with one entry per
 * exported method; route groups `(x)` and parallel slots `@x` don't appear in the URL, private
 * folders `_x` and intercepting routes `(.)x` aren't routable. Pages Router: every file under
 * `pages/` except `_app`, `_document`, `_error`, `404`, `500`; `pages/api/*` are API routes whose
 * methods can't be known statically (listed as GET). Sorted by path, then method. Pure.
 */
export function discoverRoutes(files: RepoFiles, appRoot: string): Route[] {
  const prefix = appRoot === '.' ? '' : `${appRoot}/`;
  const routes: Route[] = [];
  for (const file of files.list) {
    if (!file.startsWith(prefix)) {
      continue;
    }
    const relative = file.slice(prefix.length);
    const ext = path.posix.extname(relative).slice(1);
    if (!SOURCE_EXTENSIONS.includes(ext)) {
      continue;
    }
    const appDir = ['app/', 'src/app/'].find((dir) => relative.startsWith(dir));
    if (appDir !== undefined) {
      routes.push(...appRouterRoutes(files, file, relative.slice(appDir.length)));
      continue;
    }
    const pagesDir = ['pages/', 'src/pages/'].find((dir) => relative.startsWith(dir));
    if (pagesDir !== undefined) {
      routes.push(...pagesRouterRoutes(file, relative.slice(pagesDir.length)));
    }
  }
  return routes.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.method ?? '').localeCompare(b.method ?? '') ||
      a.file.localeCompare(b.file),
  );
}

function appRouterRoutes(files: RepoFiles, file: string, inApp: string): Route[] {
  const segments = inApp.split('/');
  const name = path.posix.basename(segments.pop() ?? '', path.posix.extname(inApp));
  if (name !== 'page' && name !== 'route') {
    return [];
  }
  if (segments.some((segment) => segment.startsWith('_') || /^\(\.{1,3}\)/.test(segment))) {
    return [];
  }
  const urlSegments = segments.filter(
    (segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith('@'),
  );
  const urlPath = `/${urlSegments.join('/')}`;
  const dynamic = urlSegments.some((segment) => segment.startsWith('['));
  if (name === 'page') {
    return [{ path: urlPath, kind: 'page', file, dynamic }];
  }
  const methods = exportedMethods(files.read(file) ?? '');
  return (methods.length > 0 ? methods : (['GET'] as const)).map((method) => ({
    path: urlPath,
    kind: 'api',
    method,
    file,
    dynamic,
  }));
}

function pagesRouterRoutes(file: string, inPages: string): Route[] {
  const withoutExt = inPages.slice(0, -path.posix.extname(inPages).length);
  const segments = withoutExt.split('/');
  if (segments.length === 1 && PAGES_SPECIAL.has(segments[0] ?? '')) {
    return [];
  }
  if (segments.at(-1) === 'index') {
    segments.pop();
  }
  const urlPath = `/${segments.join('/')}`;
  const dynamic = segments.some((segment) => segment.startsWith('['));
  return segments[0] === 'api'
    ? [{ path: urlPath, kind: 'api', method: 'GET', file, dynamic }]
    : [{ path: urlPath, kind: 'page', file, dynamic }];
}

/** HTTP methods a route handler file exports (`export function GET`, `export const POST = …`, `export { GET }`). Pure. */
export function exportedMethods(source: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  for (const method of HTTP_METHODS) {
    const declared = new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+)${method}\\b`,
    );
    const listed = new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`);
    if (declared.test(source) || listed.test(source)) {
      found.add(method);
    }
  }
  return HTTP_METHODS.filter((method) => found.has(method));
}
