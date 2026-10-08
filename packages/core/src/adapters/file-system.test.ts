import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeFileSystem as fs } from './file-system.js';

describe('nodeFileSystem', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bdiff-fs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes, appends and reads text', async () => {
    const file = path.join(dir, 'results.csv');

    await fs.writeFile(file, 'a,b\n');
    await fs.appendFile(file, '1,2\n');

    expect(await fs.readFile(file)).toBe('a,b\n1,2\n');
  });

  it('appends to a file that does not exist yet', async () => {
    const file = path.join(dir, 'new.log');

    await fs.appendFile(file, 'first');

    expect(await fs.readFile(file)).toBe('first');
  });

  it('round-trips bytes', async () => {
    const file = path.join(dir, 'shot.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);

    await fs.writeFile(file, bytes);

    expect(await fs.readFileBytes(file)).toEqual(bytes);
  });

  it('creates nested directories, lists entries sorted, renames and removes', async () => {
    const nested = path.join(dir, 'runs', 'r1');
    await fs.mkdir(nested);
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'b.json'), '{}');
    await fs.writeFile(path.join(nested, 'a.json.tmp'), '{}');
    await fs.rename(path.join(nested, 'a.json.tmp'), path.join(nested, 'a.json'));

    expect(await fs.readdir(nested)).toEqual(['a.json', 'b.json']);

    await fs.rm(path.join(dir, 'runs'));
    await fs.rm(path.join(dir, 'runs'));

    expect(await fs.exists(path.join(dir, 'runs'))).toBe(false);
  });

  it('reports existence', async () => {
    await fs.writeFile(path.join(dir, 'present'), '');

    expect(await fs.exists(path.join(dir, 'present'))).toBe(true);
    expect(await fs.exists(path.join(dir, 'absent'))).toBe(false);
  });

  it('wraps failures in FS_FAILED with the operation and path', async () => {
    const missing = path.join(dir, 'missing.txt');

    await expect(fs.readFile(missing)).rejects.toMatchObject({
      code: 'FS_FAILED',
      details: { operation: 'readFile', path: missing },
    });
  });
});

describe('nodeFileSystem.listFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bdiff-ls-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists files recursively as sorted, slash-separated relative paths', async () => {
    for (const file of [
      'b.txt',
      'a/z.ts',
      'a/b/c.ts',
      'node_modules/x/index.js',
      'a/node_modules/y.js',
    ]) {
      await fs.mkdir(path.dirname(path.join(dir, file)));
      await fs.writeFile(path.join(dir, file), '');
    }

    expect(await fs.listFiles(dir, { ignoreDirs: ['node_modules'] })).toEqual([
      'a/b/c.ts',
      'a/z.ts',
      'b.txt',
    ]);
    expect(await fs.listFiles(dir)).toContain('node_modules/x/index.js');
  });

  it('lists symbolic links without following them', async () => {
    await fs.mkdir(path.join(dir, 'real'));
    await fs.writeFile(path.join(dir, 'real', 'file.txt'), '');
    await symlink(path.join(dir, 'real'), path.join(dir, 'link'));

    expect(await fs.listFiles(dir)).toEqual(['link', 'real/file.txt']);
  });

  it('wraps a missing root in FS_FAILED', async () => {
    await expect(fs.listFiles(path.join(dir, 'missing'))).rejects.toMatchObject({
      code: 'FS_FAILED',
      details: { operation: 'listFiles' },
    });
  });
});
