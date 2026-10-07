import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

const boundaryRules = new Set(['no-restricted-imports', 'import-x/no-restricted-paths']);

// The linted files are virtual, so the TypeScript project service cannot see them. Boundary
// rules need no type information: lint without it and run only those rules.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  ruleFilter: ({ ruleId }) => boundaryRules.has(ruleId),
});

/** Lints `code` as if it lived at `file` and returns the boundary violations it triggers. */
async function boundaryViolations(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
  const messages = result?.messages ?? [];
  const fatal = messages.filter((message) => message.fatal === true);
  if (fatal.length > 0) {
    throw new Error(`ESLint could not lint ${file}: ${fatal.map((m) => m.message).join('; ')}`);
  }
  return messages.map((message) => message.message);
}

describe('package boundaries', () => {
  it.each([
    {
      from: 'packages/core/src/boundary.ts',
      code: "export { CLI_PACKAGE_NAME } from '@bdiff/cli';",
    },
    {
      from: 'packages/core/src/boundary.ts',
      code: "export { REPORT_PACKAGE_NAME } from '@bdiff/report';",
    },
    {
      from: 'packages/core/src/boundary.ts',
      code: "export { CLI_PACKAGE_NAME } from '../../cli/src/index.js';",
    },
    {
      from: 'packages/report/src/boundary.ts',
      code: "export { CLI_PACKAGE_NAME } from '@bdiff/cli';",
    },
    {
      from: 'packages/report/src/boundary.ts',
      code: "export { CLI_PACKAGE_NAME } from '../../cli/src/index.js';",
    },
  ])('rejects `$code` in $from', async ({ from, code }) => {
    const violations = await boundaryViolations(from, code);

    expect(violations).not.toHaveLength(0);
    expect(violations.join('\n')).toContain('must not import from');
  });

  it.each([
    {
      from: 'packages/report/src/boundary.ts',
      code: "export { CORE_PACKAGE_NAME } from '@bdiff/core';",
    },
    {
      from: 'packages/cli/src/boundary.ts',
      code: "export { CORE_PACKAGE_NAME } from '@bdiff/core';",
    },
    {
      from: 'packages/cli/src/boundary.ts',
      code: "export { REPORT_PACKAGE_NAME } from '@bdiff/report';",
    },
  ])('allows `$code` in $from', async ({ from, code }) => {
    expect(await boundaryViolations(from, code)).toEqual([]);
  });
});
