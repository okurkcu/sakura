import type { Recipe } from '../domain/recipe.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { PipelineStages } from '../pipeline/pipeline-stages.js';

const STUB_BASE_SHA = '0'.repeat(40);
const STUB_HEAD_SHA = '1'.repeat(40);

/** A plausible recipe for a pnpm Next.js app; what the stub recipe stage returns. */
export const STUB_RECIPE: Recipe = {
  installRoot: '.',
  appRoot: '.',
  nodeVersion: '22',
  packageManager: { name: 'pnpm' },
  installCmd: ['pnpm', 'install', '--frozen-lockfile'],
  buildCmd: ['pnpm', 'run', 'build'],
  startCmd: ['pnpm', 'exec', 'next', 'start', '-p', '3000', '-H', '0.0.0.0'],
  port: 3000,
  healthPath: '/',
  env: {},
  missingEnv: [],
  services: [],
  dbSetupCmds: [],
  confidence: 'high',
  notes: [],
};

/**
 * Stages that return fixed data without touching anything, for tests that run the pipeline with
 * only some real stages.
 */
export function createStubStages(): PipelineStages {
  return {
    workspace: {
      name: 'workspace',
      run: (_target, ctx) => {
        ctx.onCleanup('stub workspace', () => {
          ctx.logger.debug('stub workspace released');
          return Promise.resolve();
        });
        return Promise.resolve({
          basePath: 'stub/base',
          headPath: 'stub/head',
          baseSha: STUB_BASE_SHA,
          headSha: STUB_HEAD_SHA,
          changedFiles: [],
        });
      },
    },
    impact: {
      name: 'impact',
      run: () =>
        Promise.resolve({
          pages: [],
          endpoints: [],
          notProbed: [],
          confidence: 'high',
          unmappedFiles: [],
          notes: [],
        }),
    },
    recipe: { name: 'recipe', run: () => Promise.resolve(STUB_RECIPE) },
    environment: {
      name: 'environment',
      run: (_input, ctx) =>
        Promise.resolve({
          project: `bdiff-${ctx.runId}`,
          sides: {
            base: { url: 'http://127.0.0.1:1', service: 'app-base' },
            head: { url: 'http://127.0.0.1:2', service: 'app-head' },
          },
        }),
    },
    // Like a run without LLM credentials: setup failures are not repaired.
    repair: {
      propose: {
        name: 'repair',
        run: () => Promise.reject(new BdiffError('LLM_UNAVAILABLE', 'Stub repair: no LLM')),
      },
      keep: { name: 'repair', run: () => Promise.resolve() },
    },
    probeUi: { name: 'probe-ui', run: () => Promise.resolve([]) },
    probeApi: {
      name: 'probe-api',
      run: () => Promise.resolve({ requests: [], captures: [], notProbed: [] }),
    },
    diff: { name: 'diff', run: () => Promise.resolve([]) },
    interpret: {
      name: 'interpret',
      run: () =>
        Promise.resolve({
          source: 'no-findings',
          summary: [{ text: 'Stub interpretation.', findingIds: [] }],
          unexpected: [],
          riskLevel: 'low',
          coverageNote: '',
          reviewerChecklist: [],
        }),
    },
    report: { name: 'report', run: () => Promise.resolve() },
  };
}
