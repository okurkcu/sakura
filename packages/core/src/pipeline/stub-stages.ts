import type { PipelineStages } from './pipeline-stages.js';

const STUB_BASE_SHA = '0'.repeat(40);
const STUB_HEAD_SHA = '1'.repeat(40);

/**
 * Stages that return fixed data without touching anything. They keep the pipeline runnable end to
 * end until each real stage lands; the CLI uses them for every stage not yet implemented.
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
    impact: { name: 'impact', run: () => Promise.resolve({}) },
    recipe: { name: 'recipe', run: () => Promise.resolve({}) },
    environment: { name: 'environment', run: () => Promise.resolve({}) },
    probeUi: { name: 'probe-ui', run: () => Promise.resolve([]) },
    probeApi: { name: 'probe-api', run: () => Promise.resolve([]) },
    diff: { name: 'diff', run: () => Promise.resolve([]) },
    interpret: { name: 'interpret', run: () => Promise.resolve({}) },
    report: { name: 'report', run: () => Promise.resolve() },
  };
}
