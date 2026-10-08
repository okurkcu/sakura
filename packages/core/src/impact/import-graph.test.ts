import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeFileSystem } from '../adapters/file-system.js';

import { createDependencyCruiserGraph, toGraph } from './import-graph.js';

describe('createDependencyCruiserGraph (real dependency-cruiser)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-graph-'));
    const files: Record<string, string> = {
      'app/layout.tsx':
        "import './globals.css';\nimport React from 'react';\nexport default function L() { return null; }\n",
      'app/globals.css': 'body {}\n',
      'app/page.tsx':
        "import { price } from '@/lib/prices';\nimport type { Order } from '../types/order';\nexport default function P() { return price; }\n",
      'lib/prices.ts': "import { round } from 'lib/math';\nexport const price = round(1);\n",
      'lib/math.ts': 'export const round = (n: number) => Math.round(n);\n',
      'types/order.ts': 'export interface Order { id: string }\n',
      'node_modules/react/index.js': 'module.exports = {};\n',
    };
    for (const [file, content] of Object.entries(files)) {
      await nodeFileSystem.mkdir(path.dirname(path.join(root, file)));
      await writeFile(path.join(root, file), content);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds the graph with aliases, baseUrl imports, type-only imports and CSS, without following packages', async () => {
    const cwd = process.cwd();

    const graph = await createDependencyCruiserGraph().build(root, ['.'], {
      alias: { '@': root },
      moduleRoots: [root],
    });

    expect(process.cwd()).toBe(cwd);
    expect(graph.get('app/page.tsx')).toEqual(
      expect.arrayContaining(['lib/prices.ts', 'types/order.ts']),
    );
    expect(graph.get('lib/prices.ts')).toEqual(['lib/math.ts']);
    expect(graph.get('app/layout.tsx')).toEqual(['app/globals.css']);
    expect([...graph.keys()].some((file) => file.includes('node_modules'))).toBe(false);
  });
});

describe('toGraph', () => {
  it('keeps resolved local dependencies only', () => {
    const graph = toGraph({
      modules: [
        {
          source: 'a.ts',
          dependencies: [
            { resolved: 'b.ts' },
            { resolved: 'fs', coreModule: true },
            { resolved: 'missing', couldNotResolve: true },
            { resolved: 'node_modules/react/index.js' },
            { resolved: '../outside/c.ts' },
          ],
        },
        { source: 'fs', coreModule: true, dependencies: [] },
      ],
    });

    expect([...graph]).toEqual([['a.ts', ['b.ts']]]);
  });

  it('tolerates an unexpected shape', () => {
    expect(toGraph('not an object').size).toBe(0);
  });
});
