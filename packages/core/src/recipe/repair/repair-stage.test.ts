import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepairStages, REPAIR_LOG_LINES } from './repair-stage.js';
import { nodeFileSystem } from '../../adapters/file-system.js';
import type { RecipePatch, RepairRequest, SetupAttempt } from '../../domain/setup-repair.js';
import type { Workspace } from '../../domain/workspace.js';
import { BdiffError } from '../../errors/bdiff-error.js';
import { RECIPE_REPAIR_PURPOSE } from '../../llm/prompts/recipe-repair.js';
import { FakeLlmClient } from '../../testing/fake-llm-client.js';
import { createTestStageContext } from '../../testing/stage-context.js';
import { STUB_RECIPE } from '../../testing/stub-stages.js';
import { RecipeCacheEntrySchema } from '../recipe-cache.js';
import { BASE_HEAD_DIFFER_NOTE, createRecipeStage } from '../recipe-stage.js';

const app = {
  'package.json': JSON.stringify({
    packageManager: 'pnpm@9.0.0',
    scripts: { build: 'next build', start: 'node server.mjs' },
    dependencies: { next: '16' },
  }),
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'server.mjs': '',
  'README.md': '# Shop\n## Setup\nSet SESSION_SECRET to any 16+ characters.\n## License\nMIT',
  '.env': 'SESSION_SECRET=real-secret-never-read',
};

const goodPatch: RecipePatch = {
  reason: 'The build needs SESSION_SECRET and the app starts with its custom server.',
  env: [{ name: 'SESSION_SECRET', value: 'bdiff-placeholder-secret' }],
  nodeVersion: null,
  packageManager: null,
  installCmd: null,
  buildCmd: null,
  startCmd: ['pnpm', 'run', 'start'],
  dbSetupCmds: null,
  appRoot: null,
  port: null,
  healthPath: null,
};

describe('createRepairStages', () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-repair-'));
    workspace = {
      basePath: path.join(root, 'base'),
      headPath: path.join(root, 'head'),
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      changedFiles: [],
    };
    for (const dir of [workspace.basePath, workspace.headPath]) {
      await nodeFileSystem.mkdir(dir);
      for (const [file, content] of Object.entries(app)) {
        await writeFile(path.join(dir, file), content);
      }
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const setup = (llm: FakeLlmClient, budgetUsd?: number) => {
    const test = createTestStageContext({ outDir: path.join(root, 'out') });
    const stages = createRepairStages({
      fs: nodeFileSystem,
      llm,
      cacheDir: path.join(root, 'cache'),
      cwd: root,
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    });
    return { test, stages };
  };
  const request = (overrides: Partial<RepairRequest> = {}): RepairRequest => ({
    workspace,
    recipe: STUB_RECIPE,
    failure: {
      stage: 'environment',
      code: 'SETUP_BUILD_FAILED',
      message: 'head: build failed',
      side: 'head',
    },
    attempt: 1,
    maxAttempts: 3,
    previousAttempts: [],
    ...overrides,
  });

  it('asks the fast tier with the failure, log tail and README, and applies the patch', async () => {
    const llm = new FakeLlmClient().on(RECIPE_REPAIR_PURPOSE, goodPatch);
    const { test, stages } = setup(llm);
    const lines = Array.from({ length: 200 }, (_, i) => `log-${String(i).padStart(3, '0')}`);
    await nodeFileSystem.mkdir(test.ctx.paths.logsDir);
    await writeFile(test.ctx.paths.log('head'), lines.join('\n'));

    const proposal = await stages.propose.run(request(), test.ctx);

    expect(proposal).toMatchObject({
      kind: 'patched',
      tier: 'fast',
      patch: goodPatch,
      recipe: {
        startCmd: ['pnpm', 'run', 'start'],
        env: { SESSION_SECRET: { value: 'bdiff-placeholder-secret', source: 'llm' } },
      },
    });
    const [call] = llm.calls;
    expect(call?.request.tier).toBe('fast');
    const user = call?.request.messages[0]?.content ?? '';
    expect(user).toContain(`log-199`);
    expect(user).toContain(`log-${String(200 - REPAIR_LOG_LINES).padStart(3, '0')}`);
    expect(user).not.toContain(`log-${String(199 - REPAIR_LOG_LINES).padStart(3, '0')}`);
    expect(user).toContain('## Setup\nSet SESSION_SECRET to any 16+ characters.');
    expect(user).not.toContain('real-secret-never-read');
  });

  it('uses the smart tier on the last attempt and shows the earlier attempts', async () => {
    const llm = new FakeLlmClient().on(RECIPE_REPAIR_PURPOSE, goodPatch);
    const { test, stages } = setup(llm);
    const earlier: SetupAttempt = {
      attempt: 2,
      trigger: { stage: 'environment', code: 'SETUP_START_FAILED', side: 'base' },
      tier: 'fast',
      patch: null,
      outcome: 'no-patch',
      errorCode: 'LLM_INVALID_OUTPUT',
      costUsd: 0.01,
    };

    const proposal = await stages.propose.run(
      request({ attempt: 3, previousAttempts: [earlier] }),
      test.ctx,
    );

    expect(proposal.tier).toBe('smart');
    expect(llm.calls[0]?.request.tier).toBe('smart');
    expect(llm.calls[0]?.request.messages[0]?.content).toContain(
      '"errorCode":"LLM_INVALID_OUTPUT"',
    );
  });

  it('patches a fallback recipe when detection found none', async () => {
    const llm = new FakeLlmClient().on(RECIPE_REPAIR_PURPOSE, goodPatch);
    const { test, stages } = setup(llm);

    const proposal = await stages.propose.run(
      request({
        recipe: null,
        failure: { stage: 'recipe', code: 'SETUP_UNSUPPORTED', message: 'no Next.js app found' },
      }),
      test.ctx,
    );

    expect(proposal.kind).toBe('patched');
    expect(proposal.kind === 'patched' && proposal.recipe.notes[0]).toBe(
      'recipe detection failed: no Next.js app found',
    );
    expect(llm.calls[0]?.request.messages[0]?.content).toContain('fallback guess');
  });

  it('rejects a patch with a disallowed command, without applying it', async () => {
    const llm = new FakeLlmClient().on(RECIPE_REPAIR_PURPOSE, {
      ...goodPatch,
      startCmd: ['sh', '-c', 'node server.mjs'],
    });
    const { test, stages } = setup(llm);

    const proposal = await stages.propose.run(request(), test.ctx);

    expect(proposal).toMatchObject({
      kind: 'rejected',
      problems: [expect.stringMatching(/"sh -c node server\.mjs": only pnpm/)],
    });
  });

  it('stops before calling the LLM once the repair budget is spent', async () => {
    const llm = new FakeLlmClient().on(RECIPE_REPAIR_PURPOSE, goodPatch);
    const { test, stages } = setup(llm, 0.5);
    const spent: SetupAttempt = {
      attempt: 1,
      trigger: { stage: 'environment', code: 'SETUP_BUILD_FAILED' },
      tier: 'fast',
      patch: goodPatch,
      outcome: 'setup-failed',
      errorCode: 'SETUP_BUILD_FAILED',
      costUsd: 0.5,
    };

    await expect(
      stages.propose.run(request({ attempt: 2, previousAttempts: [spent] }), test.ctx),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', message: /Setup repair budget of \$0\.5/ });
    expect(llm.calls).toEqual([]);
  });

  it('respects the run budget too', async () => {
    const llm = new FakeLlmClient().on(RECIPE_REPAIR_PURPOSE, goodPatch);
    const { test, stages } = setup(llm);
    const ctx = {
      ...test.ctx,
      budget: {
        ...test.ctx.budget,
        assertAvailable: () => {
          throw new BdiffError('BUDGET_EXCEEDED', 'run budget spent');
        },
      },
    };

    await expect(stages.propose.run(request(), ctx)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      message: 'run budget spent',
    });
  });

  it('keeps a repaired recipe in the cache, where the recipe stage finds it', async () => {
    const { test, stages } = setup(new FakeLlmClient());
    const repaired = {
      ...STUB_RECIPE,
      startCmd: ['pnpm', 'run', 'start'],
      notes: ['repaired by the LLM (attempt 1): test', BASE_HEAD_DIFFER_NOTE],
    };

    await stages.keep.run({ workspace, recipe: repaired }, test.ctx);

    const cacheDir = path.join(root, 'cache', 'recipes');
    const [file] = await nodeFileSystem.readdir(cacheDir);
    const entry = RecipeCacheEntrySchema.parse(
      JSON.parse(await nodeFileSystem.readFile(path.join(cacheDir, file ?? ''))),
    );
    expect(entry).toMatchObject({ source: 'llm', recipe: { startCmd: ['pnpm', 'run', 'start'] } });
    expect(entry.recipe.notes).toEqual(['repaired by the LLM (attempt 1): test']);
    const recipe = await createRecipeStage({
      fs: nodeFileSystem,
      cacheDir: path.join(root, 'cache'),
      cwd: root,
    }).run({ workspace }, test.ctx);
    expect(recipe.startCmd).toEqual(['pnpm', 'run', 'start']);
  });
});
