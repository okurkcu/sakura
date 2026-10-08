import { realpath } from 'node:fs/promises';

import { cruise } from 'dependency-cruiser';

import type { ImportAliases } from './tsconfig-aliases.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Who imports whom: each source file (relative to the repo root) and the local files it imports. */
export type ImportGraph = ReadonlyMap<string, readonly string[]>;

/** Builds the import graph of a checkout. */
export interface ImportGraphBuilder {
  /**
   * @param root Absolute path of the checkout.
   * @param dirs Directories to scan, relative to `root` (e.g. the app directory).
   * @param resolution Resolver aliases and module roots, from `readImportAliases`.
   */
  build(
    root: string,
    dirs: readonly string[],
    resolution: Pick<ImportAliases, 'alias' | 'moduleRoots'>,
  ): Promise<ImportGraph>;
}

/**
 * {@link ImportGraphBuilder} over dependency-cruiser. It parses files statically: no repository
 * code or config (webpack, babel, dependency-cruiser config) is loaded or run. Type-only imports
 * count, so a change to a types file still maps to its users. Packages are not followed (they are
 * not installed on the host); imports that cannot be resolved, or resolve outside the checkout, are
 * dropped. The root is resolved to its real path first: the resolver follows symlinks, so a root
 * behind one (macOS `/var` → `/private/var`) would otherwise yield paths relative to the wrong base.
 */
export function createDependencyCruiserGraph(): ImportGraphBuilder {
  return {
    build: async (root, dirs, { alias, moduleRoots }) => {
      let output: unknown;
      try {
        const result = await cruise(
          [...dirs],
          {
            baseDir: await realpath(root),
            tsPreCompilationDeps: true,
            doNotFollow: { path: 'node_modules' },
            exclude: { path: '(^|/)(node_modules|\\.next|\\.git|dist|build|out|coverage)/' },
          },
          { alias, modules: [...moduleRoots, 'node_modules'] },
          {},
        );
        output = result.output;
      } catch (error) {
        throw new BdiffError('INTERNAL', 'Could not build the import graph', {
          cause: error,
          details: { root },
        });
      }
      return toGraph(output);
    },
  };
}

/** Turns a dependency-cruiser result into an {@link ImportGraph}. Pure. */
export function toGraph(output: unknown): ImportGraph {
  const graph = new Map<string, string[]>();
  const modules = isRecord(output) && Array.isArray(output.modules) ? output.modules : [];
  for (const module of modules) {
    if (
      !isRecord(module) ||
      typeof module.source !== 'string' ||
      module.coreModule === true ||
      module.couldNotResolve === true
    ) {
      continue;
    }
    const dependencies = Array.isArray(module.dependencies) ? module.dependencies : [];
    graph.set(
      module.source,
      dependencies.flatMap((dependency) =>
        isRecord(dependency) &&
        typeof dependency.resolved === 'string' &&
        dependency.couldNotResolve !== true &&
        dependency.coreModule !== true &&
        !dependency.resolved.includes('node_modules/') &&
        !dependency.resolved.startsWith('../')
          ? [dependency.resolved]
          : [],
      ),
    );
  }
  return graph;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
