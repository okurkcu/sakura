import { intersects, validRange } from 'semver';

import { inDir, readPackageJson, stringField } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';

/** Node.js majors bdiff resolves version ranges to. */
export const SUPPORTED_NODE_MAJORS = [18, 20, 22, 24] as const;
/** Used when a repository doesn't say. */
export const DEFAULT_NODE_MAJOR = '22';

const LTS_CODENAMES: Readonly<Record<string, number>> = {
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

/** The Node.js major to run a repository with. */
export interface NodeVersionDetection {
  readonly version: string;
  /** False when bdiff fell back to the default or couldn't interpret the declaration. */
  readonly certain: boolean;
  readonly notes: string[];
}

/**
 * Reads `.nvmrc`, then `.node-version` (app directory before repository root), then `engines.node`.
 * Exact versions keep their major. Ranges resolve to the default (current LTS) major when they
 * allow it, else to the highest supported major they allow: open ranges like `>=16` would otherwise
 * jump to the newest Node and risk breaking older apps.
 */
export function detectNodeVersion(files: RepoFiles, appRoot: string): NodeVersionDetection {
  const dirs = appRoot === '.' ? ['.'] : [appRoot, '.'];
  const declarations: [string, string][] = [];
  for (const file of ['.nvmrc', '.node-version']) {
    for (const dir of dirs) {
      const text = files.read(inDir(dir, file))?.trim();
      if (text !== undefined && text !== '') {
        declarations.push([inDir(dir, file), text.split('\n')[0]?.trim() ?? '']);
      }
    }
  }
  for (const dir of dirs) {
    const engines = stringField(readPackageJson(files, dir)?.engines, 'node');
    if (engines !== undefined) {
      declarations.push([`${inDir(dir, 'package.json')} engines.node`, engines]);
    }
  }

  const [source, declared] = declarations[0] ?? [];
  if (source === undefined || declared === undefined) {
    return {
      version: DEFAULT_NODE_MAJOR,
      certain: false,
      notes: [`no Node.js version declared; using ${DEFAULT_NODE_MAJOR}`],
    };
  }
  const major = resolveMajor(declared);
  if (major === undefined) {
    return {
      version: DEFAULT_NODE_MAJOR,
      certain: false,
      notes: [
        `could not interpret Node.js version "${declared}" from ${source}; using ${DEFAULT_NODE_MAJOR}`,
      ],
    };
  }
  return { version: String(major), certain: true, notes: [] };
}

/** Major version a declaration asks for, or undefined if it can't be interpreted. Pure. */
export function resolveMajor(declared: string): number | undefined {
  const spec = declared
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, '');
  if (spec === 'node' || spec === 'lts/*' || spec === 'lts') {
    return Math.max(...SUPPORTED_NODE_MAJORS);
  }
  const codename = /^lts\/(\w+)$/.exec(spec)?.[1];
  if (codename !== undefined) {
    return LTS_CODENAMES[codename];
  }
  if (/^\d+(\.\d+){0,2}$/.test(spec)) {
    return Number(spec.split('.')[0]);
  }
  const range = validRange(spec);
  if (range === null) {
    return undefined;
  }
  const allowed = SUPPORTED_NODE_MAJORS.filter((major) => intersects(range, `${String(major)}.x`));
  if (allowed.length === 0) {
    return undefined;
  }
  const preferred = Number(DEFAULT_NODE_MAJOR);
  return allowed.some((major) => major === preferred) ? preferred : Math.max(...allowed);
}
