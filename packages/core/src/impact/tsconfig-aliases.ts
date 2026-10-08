import path from 'node:path';

import { parseConfigFileTextToJson } from 'typescript';

import type { RepoFiles } from '../recipe/repo-files.js';
import { inDir } from '../recipe/repo-files.js';

const MAX_EXTENDS_DEPTH = 5;

/** Import aliases of an app, as absolute directory or file targets keyed by prefix. */
export interface ImportAliases {
  /** e.g. `{ '@': '/repo/apps/web/src' }` for `"@/*": ["./src/*"]`. */
  readonly alias: Record<string, string>;
  /** Absolute directories bare imports resolve from before `node_modules`: the `baseUrl`, if set. */
  readonly moduleRoots: string[];
  readonly notes: string[];
}

/**
 * Reads `compilerOptions.baseUrl` and `paths` from the app's `tsconfig.json` (or `jsconfig.json`)
 * and turns prefix patterns (`"@/*": ["./src/*"]`) and exact ones (`"config": ["./config.ts"]`)
 * into resolver aliases; a `baseUrl` also becomes a module root, as TypeScript and Next.js resolve
 * bare imports (`components/nav`) from it. Relative `extends` are followed; `extends` from packages are skipped
 * (dependencies are not installed on the host), with a note. Comments and trailing commas are
 * fine. Pure apart from reading `files`.
 */
export function readImportAliases(
  files: RepoFiles,
  appRoot: string,
  absoluteRoot: string,
): ImportAliases {
  const notes: string[] = [];
  const configFile = ['tsconfig.json', 'jsconfig.json']
    .map((name) => inDir(appRoot, name))
    .find((file) => files.read(file) !== undefined);
  if (configFile === undefined) {
    return { alias: {}, moduleRoots: [], notes };
  }
  const options = mergedCompilerOptions(files, configFile, notes, 0);
  const configDir = path.posix.dirname(configFile);
  const baseDir = path.posix.join(configDir, options.baseUrl ?? '.');
  const alias: Record<string, string> = {};
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const target = targets[0];
    if (target === undefined) {
      continue;
    }
    if (pattern.endsWith('/*') && target.endsWith('/*')) {
      alias[pattern.slice(0, -2)] = path.join(absoluteRoot, baseDir, target.slice(0, -2));
    } else if (!pattern.includes('*') && !target.includes('*')) {
      alias[`${pattern}$`] = path.join(absoluteRoot, baseDir, target);
    } else {
      notes.push(`unsupported path alias "${pattern}" in ${configFile}`);
    }
  }
  const moduleRoots = options.baseUrl === undefined ? [] : [path.join(absoluteRoot, baseDir)];
  return { alias, moduleRoots, notes };
}

interface PathOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

function mergedCompilerOptions(
  files: RepoFiles,
  configFile: string,
  notes: string[],
  depth: number,
): PathOptions {
  const parsed = parseConfigFileTextToJson(configFile, files.read(configFile) ?? '{}');
  const config: unknown = parsed.config;
  if (parsed.error !== undefined || !isRecord(config)) {
    notes.push(`could not parse ${configFile}`);
    return {};
  }
  let inherited: PathOptions = {};
  const extendsValue = config.extends;
  for (const parent of typeof extendsValue === 'string'
    ? [extendsValue]
    : Array.isArray(extendsValue)
      ? extendsValue
      : []) {
    if (typeof parent !== 'string') {
      continue;
    }
    if (!parent.startsWith('.') || depth >= MAX_EXTENDS_DEPTH) {
      notes.push(`skipped "extends": "${parent}" in ${configFile}`);
      continue;
    }
    const parentFile = path.posix.normalize(
      path.posix.join(
        path.posix.dirname(configFile),
        parent.endsWith('.json') ? parent : `${parent}.json`,
      ),
    );
    if (files.read(parentFile) === undefined) {
      notes.push(`"extends": "${parent}" in ${configFile} not found`);
      continue;
    }
    const parentOptions = mergedCompilerOptions(files, parentFile, notes, depth + 1);
    // A parent's baseUrl is relative to the parent's directory; rebase it onto this config's directory.
    const rebasedBaseUrl =
      parentOptions.baseUrl === undefined
        ? undefined
        : path.posix.relative(
            path.posix.dirname(configFile),
            path.posix.join(path.posix.dirname(parentFile), parentOptions.baseUrl),
          ) || '.';
    inherited = {
      ...inherited,
      ...parentOptions,
      ...(rebasedBaseUrl === undefined ? {} : { baseUrl: rebasedBaseUrl }),
    };
  }
  const own = isRecord(config.compilerOptions) ? config.compilerOptions : {};
  return {
    ...inherited,
    ...(typeof own.baseUrl === 'string' ? { baseUrl: own.baseUrl } : {}),
    ...(isRecord(own.paths) ? { paths: stringArrays(own.paths) } : {}),
  };
}

function stringArrays(value: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value).map(([key, targets]) => [
      key,
      Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : [],
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
