import { createHash } from 'node:crypto';

import { parseDotenv } from './parse-dotenv.js';
import { inDir } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';
import type { EnvSource } from '../domain/recipe.js';

/** Example env files, most specific first. Real `.env` files are never read. */
const EXAMPLE_FILES = [
  '.env.example',
  '.env.local.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
];

/** Environment of the app derived from its example env files. */
export interface EnvDetection {
  readonly env: Record<string, { value: string; source: EnvSource }>;
  readonly missing: string[];
  readonly notes: string[];
}

/**
 * Reads example env files (app directory over repository root). Example values are used as-is.
 * Empty values get a safe placeholder when the key's name says what it is: URLs point at the app
 * itself, secrets get a value derived from the key name (stable across sides and runs). Other
 * empty keys are kept empty and reported as missing. Keys in `serviceEnvVars` are left out: the
 * environment stage fills them with real service URLs.
 */
export function detectEnv(
  files: RepoFiles,
  appRoot: string,
  port: number,
  serviceEnvVars: ReadonlySet<string>,
): EnvDetection {
  const dirs = appRoot === '.' ? ['.'] : ['.', appRoot];
  const merged = new Map<string, string>();
  const read: string[] = [];
  for (const dir of dirs) {
    for (const file of [...EXAMPLE_FILES].reverse()) {
      const text = files.read(inDir(dir, file));
      if (text !== undefined) {
        read.push(inDir(dir, file));
        for (const [key, value] of parseDotenv(text)) {
          merged.set(key, value);
        }
      }
    }
  }

  const env: Record<string, { value: string; source: EnvSource }> = {};
  const missing: string[] = [];
  for (const [key, value] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    if (serviceEnvVars.has(key)) {
      continue;
    }
    if (value !== '') {
      env[key] = { value, source: 'example' };
      continue;
    }
    const placeholder = placeholderFor(key, port);
    if (placeholder === undefined) {
      env[key] = { value: '', source: 'example' };
      missing.push(key);
    } else {
      env[key] = { value: placeholder, source: 'generated' };
    }
  }
  const notes =
    missing.length > 0 ? [`no value for ${missing.join(', ')} in ${read.join(', ')}`] : [];
  return { env, missing, notes };
}

/** A safe stand-in for an empty example value, or undefined when the key's purpose is unclear. Pure. */
export function placeholderFor(key: string, port: number): string | undefined {
  const upper = key.toUpperCase();
  if (/(^|_)(URL|URI|ORIGIN|HOST_URL|BASE_URL)$/.test(upper)) {
    return `http://localhost:${String(port)}`;
  }
  if (/SECRET|PASSWORD|TOKEN|SALT|PRIVATE|(^|_)KEY($|_)/.test(upper)) {
    return `bdiff-${createHash('sha256').update(`bdiff-placeholder:${key}`).digest('hex').slice(0, 32)}`;
  }
  return undefined;
}
