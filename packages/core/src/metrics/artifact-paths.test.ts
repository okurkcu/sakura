import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { artifactFileStem, createArtifactPaths } from './artifact-paths.js';
import { TEST_RUN_ID } from '../testing/run-records.js';

const root = '/work/.bdiff';
const runDir = `/work/.bdiff/runs/${TEST_RUN_ID}`;

describe('createArtifactPaths', () => {
  const paths = createArtifactPaths(root, TEST_RUN_ID);

  it('lays out the run directory', () => {
    expect(paths).toMatchObject({
      root,
      resultsCsv: '/work/.bdiff/results.csv',
      runDir,
      runJson: `${runDir}/run.json`,
      composeFile: `${runDir}/compose.yml`,
      logsDir: `${runDir}/logs`,
      diffDir: `${runDir}/diff`,
      reportDir: `${runDir}/report`,
      reportHtml: `${runDir}/report/index.html`,
    });
    expect(paths.log('head')).toBe(`${runDir}/logs/head.log`);
    expect(paths.worktree('base')).toBe(`${runDir}/worktrees/base`);
    expect(paths.worktree('head')).toBe(`${runDir}/worktrees/head`);
  });

  it('places screenshots and API responses per probe run', () => {
    expect(paths.uiScreenshot('baseA', '/login')).toMatch(
      new RegExp(`^${runDir}/ui/baseA/login-[0-9a-f]{8}\\.png$`),
    );
    expect(paths.apiResponse('head', 'GET /api/orders/latest')).toMatch(
      new RegExp(`^${runDir}/api/head/get-api-orders-latest-[0-9a-f]{8}\\.json$`),
    );
    expect(paths.diffOverlay('/login')).toMatch(
      new RegExp(`^${runDir}/diff/ui/login-[0-9a-f]{8}\\.png$`),
    );
  });

  it('rejects a run id that is not a ULID', () => {
    expect(() => createArtifactPaths(root, '../escape')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it.each(['../base', 'Head', 'a/b', ''])('rejects the log name %j', (name) => {
    expect(() => paths.log(name)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it.each([
    '/',
    '/../../etc/passwd',
    '..',
    '/a/../../b',
    '\\..\\windows',
    '/über/straße',
    'x'.repeat(500),
  ])('keeps the screenshot of route %j inside its directory', (route) => {
    const file = paths.uiScreenshot('baseB', route);

    expect(path.dirname(file)).toBe(`${runDir}/ui/baseB`);
    expect(path.basename(file)).toMatch(/^[a-z0-9-]{1,60}-[0-9a-f]{8}\.png$/);
  });
});

describe('artifactFileStem', () => {
  it('is deterministic', () => {
    expect(artifactFileStem('/orders')).toBe(artifactFileStem('/orders'));
  });

  it('names the root route index', () => {
    expect(artifactFileStem('/')).toMatch(/^index-[0-9a-f]{8}$/);
  });

  it.each([
    ['/a/b', '/a-b'],
    ['/Orders', '/orders'],
    ['GET /api/x', 'POST /api/x'],
  ])('keeps %j and %j apart', (first, second) => {
    expect(artifactFileStem(first)).not.toBe(artifactFileStem(second));
  });
});
