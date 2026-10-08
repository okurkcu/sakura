import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BdiffError, createArtifactPaths, nodeFileSystem } from '@bdiff/core';
import { createTestRunRecorder, createTestStageContext, TEST_RUN_ID } from '@bdiff/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createReportStage, renderBatchIndex } from './report-stage.js';
import { skippedResult } from './testing/results.js';

describe('createReportStage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-report-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes report/index.html', async () => {
    const test = createTestStageContext({ outDir: root });

    await createReportStage({ fs: nodeFileSystem }).run(skippedResult(), test.ctx);

    expect(await readFile(test.ctx.paths.reportHtml, 'utf8')).toContain(
      '<h2>Skipped: docs-only</h2>',
    );
  });

  it("shows the last lines of the run's logs on a failed run that recorded no log tail", async () => {
    const test = createTestStageContext({ outDir: root });
    const paths = createArtifactPaths(root, TEST_RUN_ID);
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(
      paths.log('head'),
      `${Array.from({ length: 60 }, (_, i) => `line ${String(i + 1)}`).join('\n')}\n`,
    );
    const { recorder } = createTestRunRecorder();
    const record = recorder.finish({
      status: 'failed',
      error: new BdiffError('SETUP_START_FAILED', 'Head never became healthy'),
      stage: 'environment',
    });

    await createReportStage({ fs: nodeFileSystem }).run({ record }, test.ctx);

    const page = await readFile(test.ctx.paths.reportHtml, 'utf8');
    expect(page).toContain('head.log: last 40 lines');
    expect(page).toContain('line 60');
    expect(page).not.toContain('line 20\n');
    expect(page).toContain('href="../logs/head.log"');
  });
});

describe('createReportStage logs', () => {
  it('shows no log lines when a later stage failed, but still links the logs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bdiff-report-'));
    try {
      const test = createTestStageContext({ outDir: root });
      const paths = createArtifactPaths(root, TEST_RUN_ID);
      await mkdir(paths.logsDir, { recursive: true });
      await writeFile(paths.log('head'), 'Compiled successfully\n');
      const { recorder } = createTestRunRecorder();
      const record = recorder.finish({
        status: 'failed',
        error: new BdiffError('LLM_UNAVAILABLE', 'No Claude API credentials'),
        stage: 'interpret',
      });

      await createReportStage({ fs: nodeFileSystem }).run({ record }, test.ctx);

      const page = await readFile(test.ctx.paths.reportHtml, 'utf8');
      expect(page).toContain('<h2>Failed at interpret: LLM_UNAVAILABLE</h2>');
      expect(page).not.toContain('Compiled successfully');
      expect(page).toContain('href="../logs/head.log"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderBatchIndex', () => {
  it('writes the index file, creating its directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bdiff-batch-'));
    try {
      const file = path.join(root, 'report', 'batch-index.html');

      await renderBatchIndex([{ record: skippedResult().record }], file, nodeFileSystem);

      expect(await readFile(file, 'utf8')).toContain('1 runs · 0 failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
