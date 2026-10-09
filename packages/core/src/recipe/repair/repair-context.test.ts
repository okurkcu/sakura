import { describe, expect, it } from 'vitest';

import {
  isRepairContextFile,
  MAX_README_CHARS,
  MAX_TREE_ENTRIES,
  readmeSetupSections,
  repairRepoContext,
} from './repair-context.js';
import { createRepoFiles } from '../repo-files.js';

describe('readmeSetupSections', () => {
  it('keeps the sections about setup, install, configuration and running', () => {
    const readme = [
      '# Shop',
      'A storefront.',
      '## Features',
      'Many.',
      '## Setup',
      'Set SESSION_SECRET.',
      '### Database',
      'Ignored subsection.',
      '## Running locally',
      'pnpm start',
      '## License',
      'MIT',
    ].join('\n');

    expect(readmeSetupSections(readme)).toBe(
      '## Setup\nSet SESSION_SECRET.\n\n## Running locally\npnpm start',
    );
  });

  it('keeps the start of the README when no heading is about setup, cut to the limit', () => {
    expect(readmeSetupSections('# Shop\nA storefront.')).toBe('# Shop\nA storefront.');
    const long = readmeSetupSections(`# Shop\n${'x'.repeat(MAX_README_CHARS * 2)}`);
    expect(long.length).toBeLessThan(MAX_README_CHARS + 50);
    expect(long).toMatch(/cut by bdiff\)$/);
  });
});

describe('repairRepoContext', () => {
  const files = createRepoFiles(
    {
      'package.json': '{"name":"root"}',
      'apps/web/package.json': '{"name":"web"}',
      'packages/ui/package.json': '{"name":"ui"}',
      'apps/web/.env.example': 'SESSION_SECRET=\n',
      'README.md': '# Root\n## Install\npnpm install',
      'apps/web/README.md': '# Web\n## Getting started\nnode server.mjs',
      'docs/README.md': '# Docs\n## Setup\nignored: not the root or app root',
    },
    ['.env', 'apps/web/app/page.tsx', 'apps/web/app/a/b/c/deep.tsx'],
  );

  it('shows a depth-limited tree and the files that explain setup, never a real .env', () => {
    const context = repairRepoContext(files, 'apps/web');

    expect(context.tree).toContain('apps/web/app/');
    expect(context.tree).not.toContain('apps/web/app/page.tsx');
    expect(context.tree).toContain('.env');
    expect(context.treeCut).toBe(0);
    expect(context.documents.map((doc) => doc.path)).toEqual([
      'package.json',
      'apps/web/package.json',
      'packages/ui/package.json',
      'README.md',
      'apps/web/.env.example',
      'apps/web/README.md',
    ]);
    expect(context.documents.find((doc) => doc.path === 'apps/web/README.md')?.content).toBe(
      '## Getting started\nnode server.mjs',
    );
  });

  it('caps the tree', () => {
    const many = createRepoFiles(
      {},
      Array.from({ length: MAX_TREE_ENTRIES + 20 }, (_, i) => `f${String(i)}.ts`),
    );

    const context = repairRepoContext(many, '.');

    expect(context.tree).toHaveLength(MAX_TREE_ENTRIES);
    expect(context.treeCut).toBe(20);
  });
});

describe('isRepairContextFile', () => {
  it.each([
    ['package.json', true],
    ['README.md', true],
    ['apps/web/readme.mdx', true],
    ['.env.example', true],
    ['.env', false],
    ['.env.local', false],
    ['app/page.tsx', false],
  ])('%s → %s', (file, read) => {
    expect(isRepairContextFile(file)).toBe(read);
  });
});
