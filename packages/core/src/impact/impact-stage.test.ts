import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createImpactStage } from './impact-stage.js';
import type { ImportGraph, ImportGraphBuilder } from './import-graph.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import type { ChangedFile, Workspace } from '../domain/workspace.js';
import { createTestStageContext } from '../testing/stage-context.js';

const SHA = 'a'.repeat(40);
const NEXT_PACKAGE = '{ "dependencies": { "next": "16.0.0" } }';

/** A graph builder that returns a fixed graph and records how it was called. */
function fakeGraph(graph: ImportGraph = new Map()): ImportGraphBuilder & {
  readonly calls: Parameters<ImportGraphBuilder['build']>[];
} {
  const calls: Parameters<ImportGraphBuilder['build']>[] = [];
  return {
    calls,
    build: (...args) => {
      calls.push(args);
      return Promise.resolve(graph);
    },
  };
}

describe('createImpactStage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-impact-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function workspace(
    trees: { base: Record<string, string>; head: Record<string, string> },
    changedFiles: ChangedFile[],
  ): Promise<Workspace> {
    for (const side of ['base', 'head'] as const) {
      for (const [file, content] of Object.entries(trees[side])) {
        await nodeFileSystem.mkdir(path.dirname(path.join(root, side, file)));
        await writeFile(path.join(root, side, file), content);
      }
    }
    return {
      basePath: path.join(root, 'base'),
      headPath: path.join(root, 'head'),
      baseSha: SHA,
      headSha: SHA,
      changedFiles,
    };
  }

  it('skips without reading files or building the graph when nothing runtime changed', async () => {
    const graph = fakeGraph();
    const test = createTestStageContext();

    const plan = await createImpactStage({ fs: nodeFileSystem, graph }).run(
      {
        workspace: {
          basePath: path.join(root, 'missing-base'),
          headPath: path.join(root, 'missing-head'),
          baseSha: SHA,
          headSha: SHA,
          changedFiles: [{ status: 'modified', path: 'docs/intro.md' }],
        },
      },
      test.ctx,
    );

    expect(plan).toMatchObject({ skip: { reason: 'docs-only' }, pages: [], endpoints: [] });
    expect(graph.calls).toEqual([]);
  });

  it('probes routes deleted or renamed away in head, taking them from base', async () => {
    const page = 'export default function Page() { return null; }\n';
    const manifest = { 'package.json': NEXT_PACKAGE };
    const ws = await workspace(
      {
        base: {
          ...manifest,
          'app/page.tsx': page,
          'app/old/page.tsx': page,
          'app/a/page.tsx': page,
        },
        head: { ...manifest, 'app/page.tsx': page, 'app/b/page.tsx': page },
      },
      [
        { status: 'deleted', path: 'app/old/page.tsx' },
        { status: 'renamed', path: 'app/b/page.tsx', oldPath: 'app/a/page.tsx' },
      ],
    );

    const plan = await createImpactStage({ fs: nodeFileSystem, graph: fakeGraph() }).run(
      { workspace: ws },
      createTestStageContext().ctx,
    );

    expect(plan.pages.map((route) => route.path)).toEqual(['/a', '/b', '/old']);
    expect(plan.confidence).toBe('high');
  });

  it('builds the head graph over the app directory with the tsconfig aliases and maps changes through it', async () => {
    const graph = fakeGraph(
      new Map([
        ['apps/web/app/page.tsx', ['apps/web/components/hero.tsx']],
        ['apps/web/app/api/ping/route.ts', ['apps/web/lib/db.ts']],
      ]),
    );
    const head = {
      'package.json': '{ "workspaces": ["apps/*"] }',
      'apps/web/package.json': NEXT_PACKAGE,
      'apps/web/next.config.ts': 'export default {};\n',
      'apps/web/tsconfig.json':
        '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }',
      'apps/web/app/page.tsx': 'export default function Home() { return null; }\n',
      'apps/web/app/api/ping/route.ts': 'export async function POST() {}\n',
    };
    const ws = await workspace({ base: head, head }, [
      { status: 'modified', path: 'apps/web/components/hero.tsx' },
      { status: 'modified', path: 'apps/web/lib/db.ts' },
      { status: 'modified', path: 'apps/web/README.md' },
    ]);

    const plan = await createImpactStage({ fs: nodeFileSystem, graph }).run(
      { workspace: ws },
      createTestStageContext().ctx,
    );

    expect(graph.calls).toEqual([
      [
        ws.headPath,
        ['apps/web'],
        {
          alias: { '@': path.join(ws.headPath, 'apps/web') },
          moduleRoots: [path.join(ws.headPath, 'apps/web')],
          notes: [],
        },
      ],
    ]);
    expect(plan).toMatchObject({
      pages: [{ path: '/' }],
      endpoints: [{ path: '/api/ping', method: 'POST' }],
      unmappedFiles: [],
      confidence: 'high',
    });
  });
});
