import { createMemoryFileSystem } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import { buildDemo, keptFile, replacePaths } from './build-demo.js';

describe('build-demo', () => {
  it.each([
    ['run.json', true],
    ['ui/head/a.png', true],
    ['report/index.html', true],
    ['worktrees/head/package.json', false],
    ['secrets.env', false],
  ])('keeps %s: %s', (file, kept) => {
    expect(keptFile(file)).toBe(kept);
  });

  it('replaces longer paths first', () => {
    expect(
      replacePaths('/Users/me/ws/runs/x and /Users/me', [
        ['/Users/me', '/demo/home'],
        ['/Users/me/ws', '/demo/.bdiff'],
      ]),
    ).toBe('/demo/.bdiff/runs/x and /demo/home');
  });

  it('copies finished and live runs without local paths or worktrees', async () => {
    const fs = createMemoryFileSystem({
      '/Users/me/ws/runs/r1/run.json':
        '{"screenshot":"/Users/me/ws/runs/r1/ui/a.png","repo":"/tmp/repo"}',
      '/Users/me/ws/runs/r1/ui/a.png': new Uint8Array([1, 2]),
      '/Users/me/ws/runs/r1/worktrees/head/x.ts': 'code',
      '/Users/me/ws/runs/r2/events.jsonl': '{"repo":"/tmp/repo"}\n',
      '/old/demo/runs/stale/run.json': '{}',
    });

    await buildDemo(fs, {
      workspace: '/Users/me/ws',
      demoDir: '/old/demo',
      finished: ['r1'],
      live: 'r2',
      replacements: [['/tmp/repo', '/demo/fixture-repo']],
    });

    expect([...fs.files.keys()].filter((file) => file.startsWith('/old/demo')).sort()).toEqual([
      '/old/demo/live/runs/r2/events.jsonl',
      '/old/demo/runs/r1/run.json',
      '/old/demo/runs/r1/ui/a.png',
    ]);
    expect(fs.files.get('/old/demo/runs/r1/run.json')).toBe(
      '{"screenshot":"/demo/.bdiff/runs/r1/ui/a.png","repo":"/demo/fixture-repo"}',
    );
  });
});
