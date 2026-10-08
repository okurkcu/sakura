import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExplicitRequestSchema, loadExplicitRequests, REQUESTS_FILE } from './requests-file.js';
import { nodeFileSystem } from '../../adapters/file-system.js';

describe('ExplicitRequestSchema', () => {
  it.each([
    [{ method: 'GET', path: '/api/orders?page=2' }, true],
    [{ method: 'POST', path: '/api/x', json: { a: 1 }, headers: { 'X-Tenant': 'demo' } }, true],
    [
      {
        method: 'POST',
        path: '/api/x',
        text: 'a=1',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      true,
    ],
    [{ method: 'POST', path: '/api/x', json: {}, text: '' }, false],
    [{ method: 'GET', path: '//evil.example/x' }, false],
    [{ method: 'GET', path: '/\\evil.example/x' }, false],
    [{ method: 'GET', path: 'https://evil.example/x' }, false],
    [{ method: 'GET', path: '/api/x', headers: { Cookie: 'session=1' } }, false],
    [{ method: 'GET', path: '/api/x', headers: { Host: 'evil.example' } }, false],
    [{ method: 'GET', path: '/api/x', headers: { 'bad header': '1' } }, false],
    [{ method: 'TRACE', path: '/api/x' }, false],
  ])('validates %j as %s', (request, ok) => {
    expect(ExplicitRequestSchema.safeParse(request).success).toBe(ok);
  });
});

describe('loadExplicitRequests', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-requests-'));
    await mkdir(path.join(root, 'apps/web'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers the app root over the repository root', async () => {
    await writeFile(
      path.join(root, REQUESTS_FILE),
      '{ "requests": [{ "method": "GET", "path": "/root" }] }',
    );
    await writeFile(
      path.join(root, 'apps/web', REQUESTS_FILE),
      '{ "requests": [{ "method": "GET", "path": "/app" }] }',
    );

    expect(await loadExplicitRequests(nodeFileSystem, root, 'apps/web')).toEqual([
      { method: 'GET', path: '/app' },
    ]);
    expect(await loadExplicitRequests(nodeFileSystem, root, 'apps/other')).toEqual([
      { method: 'GET', path: '/root' },
    ]);
  });

  it('returns nothing without a file', async () => {
    expect(await loadExplicitRequests(nodeFileSystem, root, '.')).toEqual([]);
  });

  it.each([
    ['{ not json', /not valid JSON/],
    ['{ "requests": [{ "method": "GET", "path": "//evil.example" }] }', /is invalid/],
  ])('rejects %j with CONFIG_INVALID', async (content, message) => {
    await writeFile(path.join(root, REQUESTS_FILE), content);

    await expect(loadExplicitRequests(nodeFileSystem, root, '.')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(message) as unknown,
    });
  });
});
