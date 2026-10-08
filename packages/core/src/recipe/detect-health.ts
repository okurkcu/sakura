import type { RepoFiles } from './repo-files.js';

/** Route files of a conventional health endpoint, relative to the app directory. */
const HEALTH_ROUTES: readonly (readonly [string, string])[] = [
  ['app/api/health/route', '/api/health'],
  ['src/app/api/health/route', '/api/health'],
  ['pages/api/health', '/api/health'],
  ['src/pages/api/health', '/api/health'],
  ['app/api/healthz/route', '/api/healthz'],
  ['src/app/api/healthz/route', '/api/healthz'],
];

/** Path to poll until the app is up: a health endpoint if the app has one, else `/`. */
export function detectHealthPath(files: RepoFiles, appRoot: string): string {
  const prefix = appRoot === '.' ? '' : `${appRoot}/`;
  for (const [route, url] of HEALTH_ROUTES) {
    if (['ts', 'js', 'tsx', 'jsx', 'mjs'].some((ext) => files.has(`${prefix}${route}.${ext}`))) {
      return url;
    }
  }
  return '/';
}
