/**
 * Test helper run as a real subprocess: `bdiff run` whose environment stage blocks until the run
 * aborts, with real process signals. Prints `READY` once blocked and `CLEANED <hook>` when a cleanup
 * hook runs, so a test can send SIGINT and observe the result.
 */
import { abortError, createStubStages, systemClock } from '@bdiff/core';

import { createDefaultCliDeps, runCli } from '../src/cli.js';

const stubs = createStubStages();
const deps = createDefaultCliDeps(process.env);

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    signals: process,
    forceExit: (code) => {
      process.exit(code);
    },
  },
  {
    ...deps,
    clock: systemClock,
    stages: {
      ...stubs,
      workspace: {
        name: 'workspace',
        run: (target, ctx) => {
          ctx.onCleanup('worktrees', () => {
            process.stdout.write('CLEANED worktrees\n');
            return Promise.resolve();
          });
          return stubs.workspace.run(target, ctx);
        },
      },
      environment: {
        name: 'environment',
        run: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.onCleanup('containers', () => {
              process.stdout.write('CLEANED containers\n');
              return Promise.resolve();
            });
            ctx.signal.addEventListener('abort', () => {
              reject(abortError(ctx.signal));
            });
            process.stdout.write('READY\n');
          }),
      },
    },
  },
);
