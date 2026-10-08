import path from 'node:path';

import { affectedRoutes, routeKey } from './impact-mapping.js';
import { buildImpactPlan, DEFAULT_IMPACT_LIMITS } from './impact-plan.js';
import type { ImpactLimits } from './impact-plan.js';
import type { ImportGraphBuilder } from './import-graph.js';
import { discoverRoutes } from './route-discovery.js';
import { classifyChange, skipReason } from './skip-rules.js';
import { readImportAliases } from './tsconfig-aliases.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { ImpactPlan, Route } from '../domain/impact.js';
import type { Workspace } from '../domain/workspace.js';
import type { Stage } from '../pipeline/stage.js';
import { detectAppRoot } from '../recipe/detect-app-root.js';
import { isRelevantFile, loadFilesWhere } from '../recipe/repo-files.js';

/** Dependencies of the impact stage. */
export interface ImpactStageDeps {
  readonly fs: FileSystem;
  readonly graph: ImportGraphBuilder;
  readonly limits?: ImpactLimits;
}

/** Files the impact stage reads: manifests, TS/JS configs and route handlers (for their methods). */
function readForImpact(file: string): boolean {
  const name = path.posix.basename(file);
  return (
    isRelevantFile(file) ||
    name === 'tsconfig.json' ||
    name === 'jsconfig.json' ||
    /^route\.[cm]?[jt]sx?$/.test(name)
  );
}

/**
 * The impact stage: decides which pages and API endpoints the PR can affect, so only those are
 * probed. Skips the run when only docs, tests, CI config or lockfiles changed. Otherwise discovers
 * the app's routes (head, plus routes deleted or moved away in head, from base), builds the head's
 * import graph, and walks it backwards from each changed runtime file. Runs before the recipe
 * stage, so it finds the app directory itself, with the same detector.
 */
export function createImpactStage(
  deps: ImpactStageDeps,
): Stage<{ workspace: Workspace }, ImpactPlan> {
  return {
    name: 'impact',
    run: async ({ workspace }, ctx) => {
      const reason = skipReason(workspace.changedFiles);
      if (reason !== undefined) {
        ctx.logger.info('nothing to probe; skipping', { reason });
        return {
          skip: { reason },
          pages: [],
          endpoints: [],
          notProbed: [],
          confidence: 'high',
          unmappedFiles: [],
          notes: [],
        };
      }

      const head = await loadFilesWhere(deps.fs, workspace.headPath, readForImpact);
      const { appRoot } = detectAppRoot(head);
      const base = await loadFilesWhere(deps.fs, workspace.basePath, readForImpact);
      const goneInHead = new Set(
        workspace.changedFiles.flatMap((file) =>
          file.status === 'deleted' ? [file.path] : file.status === 'renamed' ? [file.oldPath] : [],
        ),
      );
      const routes = uniqueRoutes([
        ...discoverRoutes(head, appRoot),
        ...discoverRoutes(base, appRoot).filter((route) => goneInHead.has(route.file)),
      ]);

      const aliases = readImportAliases(head, appRoot, workspace.headPath);
      const graph = await deps.graph.build(workspace.headPath, [appRoot], aliases);
      const changed = workspace.changedFiles.flatMap((file) =>
        file.status === 'deleted'
          ? routes.some((route) => route.file === file.path)
            ? [file.path]
            : []
          : file.status === 'renamed'
            ? [
                file.path,
                ...(routes.some((route) => route.file === file.oldPath) ? [file.oldPath] : []),
              ]
            : [file.path],
      );
      const runtimeChanges = changed.filter((file) => classifyChange(file) === 'runtime');
      const { affected, unmappedFiles } = affectedRoutes(runtimeChanges, routes, graph);
      const plan = buildImpactPlan({
        routes,
        affected,
        unmappedFiles,
        limits: deps.limits ?? DEFAULT_IMPACT_LIMITS,
        notes: aliases.notes,
      });
      ctx.logger.info('impact planned', {
        appRoot,
        pages: plan.pages.map(routeKey),
        endpoints: plan.endpoints.map(routeKey),
        notProbed: plan.notProbed.length,
        confidence: plan.confidence,
      });
      return plan;
    },
  };
}

function uniqueRoutes(routes: readonly Route[]): Route[] {
  const byKey = new Map<string, Route>();
  for (const route of routes) {
    if (!byKey.has(routeKey(route))) {
      byKey.set(routeKey(route), route);
    }
  }
  return [...byKey.values()];
}
