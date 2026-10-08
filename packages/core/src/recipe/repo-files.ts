import path from 'node:path';

import type { FileSystem } from '../adapters/file-system.js';

/** Directories never scanned: dependencies, VCS data and build output. */
const IGNORED_DIRS = [
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'out',
];

/** File names whose content recipe detection reads. */
const RELEVANT_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  '.yarnrc.yml',
  '.nvmrc',
  '.node-version',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.dist',
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]);

/** A read-only snapshot of a repository's file tree for detectors. */
export interface RepoFiles {
  /** Every file path, `/`-separated and relative to the repository root, sorted. */
  readonly list: readonly string[];
  /** Content of a relevant file, or undefined if it doesn't exist or wasn't loaded. */
  read(file: string): string | undefined;
  /** Whether a file exists. */
  has(file: string): boolean;
}

/** Whether recipe detection needs the content of `file`. */
export function isRelevantFile(file: string): boolean {
  const name = path.posix.basename(file);
  return (
    RELEVANT_NAMES.has(name) ||
    name.endsWith('.prisma') ||
    /^drizzle\.config\.[cm]?[jt]s$|^drizzle\.config\.json$/.test(name)
  );
}

/** Creates {@link RepoFiles} from an in-memory map of path to content. For tests and loaded trees. */
export function createRepoFiles(
  contents: Readonly<Record<string, string>>,
  extraFiles: readonly string[] = [],
): RepoFiles {
  const list = [...new Set([...Object.keys(contents), ...extraFiles])].sort();
  const present = new Set(list);
  return {
    list,
    read: (file) => contents[file],
    has: (file) => present.has(file),
  };
}

/** Lists a checkout and loads the content of every relevant file (`bun.lockb` is listed, not read). */
export async function loadRepoFiles(fs: FileSystem, root: string): Promise<RepoFiles> {
  const list = await fs.listFiles(root, { ignoreDirs: IGNORED_DIRS });
  const contents: Record<string, string> = {};
  for (const file of list.filter(isRelevantFile)) {
    contents[file] = await fs.readFile(path.join(root, file));
  }
  return createRepoFiles(contents, list);
}

/** Joins a directory relative to the repository root (`.` is the root) with a file name. */
export function inDir(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

/** Parses a `package.json`, or undefined if it's missing or not a JSON object. */
export function readPackageJson(files: RepoFiles, dir: string): PackageJson | undefined {
  const text = files.read(inDir(dir, 'package.json'));
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    // An unparseable package.json is treated as absent; detection then reports what it lacks.
    return undefined;
  }
}

/** The parts of `package.json` detection reads. Every field is untrusted and may have any type. */
export interface PackageJson {
  readonly name?: unknown;
  readonly packageManager?: unknown;
  readonly scripts?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly engines?: unknown;
  readonly workspaces?: unknown;
  readonly prisma?: unknown;
}

/** A string-valued field of an untrusted object, or undefined. */
export function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/** Whether a package.json depends on `name` (dependencies or devDependencies). */
export function dependsOn(pkg: PackageJson, name: string): boolean {
  return (
    stringField(pkg.dependencies, name) !== undefined ||
    stringField(pkg.devDependencies, name) !== undefined
  );
}
