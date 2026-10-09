import { createHash } from 'node:crypto';
import path from 'node:path';

import { BdiffError } from '@bdiff/core';
import type { FileSystem, Logger } from '@bdiff/core';

/** Root of the panel package (`src/server/` and `dist/server/` are two levels down). */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..');

/** Where the panel's files are. */
export const PANEL_PATHS = {
  /** Sources of the web UI. */
  webSource: path.join(PACKAGE_ROOT, 'web'),
  /** The built web UI that the server serves. */
  webDist: path.join(PACKAGE_ROOT, 'dist', 'web'),
  /** The demo workspace of `bdiff ui --demo`. */
  demo: path.join(PACKAGE_ROOT, 'demo'),
  /** Server-side files the web UI imports (shared types and helpers), part of its build. */
  sharedSources: ['api.ts', 'paths.ts', 'stages.ts'].map((file) =>
    path.join(PACKAGE_ROOT, 'src', file),
  ),
} as const;

/** File recording which sources a build was made from. */
const SOURCE_HASH_FILE = '.source-hash';

/** Inputs of {@link ensureWebBuild}. */
export interface WebBuildOptions {
  readonly fs: FileSystem;
  readonly logger: Logger;
  /** Web UI sources (with `index.html`). */
  readonly sourceDir: string;
  /** Output directory. */
  readonly outDir: string;
  /** Also hashed: code the UI imports from outside `sourceDir` (shared API types, helpers). */
  readonly sharedFiles?: readonly string[];
}

/**
 * Builds the web UI with Vite unless `outDir` already holds a build of the same sources (compared
 * by a hash of their contents), so `bdiff ui` starts at once after the first time. The UI is
 * bundled with its fonts and images: the page loads nothing from the network.
 *
 * @throws BdiffError `INTERNAL` when the build fails.
 */
export async function ensureWebBuild(options: WebBuildOptions): Promise<'fresh' | 'built'> {
  const { fs, logger, sourceDir, outDir } = options;
  const hash = await sourceHash(fs, sourceDir, options.sharedFiles ?? []);
  const hashFile = path.join(outDir, SOURCE_HASH_FILE);
  if (
    (await fs.exists(path.join(outDir, 'index.html'))) &&
    (await fs.exists(hashFile)) &&
    (await fs.readFile(hashFile)).trim() === hash
  ) {
    return 'fresh';
  }
  logger.info('building the panel UI', { outDir });
  try {
    const { build } = await import('vite');
    await build({
      root: sourceDir,
      base: '/',
      logLevel: 'warn',
      configFile: false,
      publicDir: false,
      oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
      build: { outDir, emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
    });
  } catch (error) {
    throw new BdiffError('INTERNAL', 'The panel UI could not be built', { cause: error });
  }
  await fs.writeFile(hashFile, `${hash}\n`);
  return 'built';
}

async function sourceHash(
  fs: FileSystem,
  sourceDir: string,
  sharedFiles: readonly string[],
): Promise<string> {
  const hash = createHash('sha256');
  const files = (await fs.listFiles(sourceDir, { ignoreDirs: ['node_modules'] }))
    .filter((file) => !file.includes('.test.'))
    .map((file) => path.join(sourceDir, file));
  for (const file of [...files, ...sharedFiles]) {
    hash.update(file);
    hash.update(await fs.readFileBytes(file));
  }
  return hash.digest('hex');
}
