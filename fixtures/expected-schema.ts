import path from 'node:path';

import type { FileSystem } from '@bdiff/core';
import { ChangedFileSchema, FindingKindSchema, SeveritySchema, BdiffError } from '@bdiff/core';
import { z } from 'zod';

const routeSchema = z.string().regex(/^\/[a-z0-9/-]*$/, 'expected a static route such as /login');
const endpointSchema = z
  .string()
  .regex(
    /^(GET|POST|PUT|PATCH|DELETE) \/[a-z0-9/-]*$/,
    'expected an endpoint such as GET /api/health',
  );

/** A finding the pipeline must report: kind, optional severity and where it is. */
export const ExpectedFindingSchema = z.strictObject({
  kind: FindingKindSchema,
  severity: SeveritySchema.exactOptional(),
  location: z.strictObject({
    route: routeSchema.exactOptional(),
    endpoint: endpointSchema.exactOptional(),
    jsonPath: z.string().startsWith('$').exactOptional(),
  }),
});
export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

/** Ground truth for one PR branch. */
export const ExpectedBranchSchema = z
  .strictObject({
    description: z.string().min(1),
    /** Exactly what `git diff --name-status -M main..<branch>` reports. */
    changedFiles: z.array(ChangedFileSchema),
    impact: z.strictObject({
      skip: z.strictObject({ reason: z.string().min(1) }).exactOptional(),
      routes: z.array(routeSchema),
      endpoints: z.array(endpointSchema),
    }),
    findings: z.array(ExpectedFindingSchema),
  })
  .superRefine((branch, ctx) => {
    const skipped = branch.impact.skip !== undefined;
    if (skipped && (branch.impact.routes.length > 0 || branch.impact.endpoints.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['impact'],
        message: 'a skipped branch probes nothing',
      });
    }
    if (skipped && branch.findings.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'a skipped branch has no findings',
      });
    }
  });
export type ExpectedBranch = z.infer<typeof ExpectedBranchSchema>;

/** The contents of `fixtures/expected.json`. */
export const ExpectedSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    baseBranch: z.literal('main'),
    /** Every static page of the base app. */
    pages: z.array(routeSchema).min(1),
    /** Every static API endpoint of the base app. */
    endpoints: z.array(endpointSchema).min(1),
    /** Pages whose content changes on every request; they must never produce a finding. */
    noisyRoutes: z.array(routeSchema),
    branches: z.strictObject({
      'pr/ui-change': ExpectedBranchSchema,
      'pr/api-breaking': ExpectedBranchSchema,
      'pr/refactor-no-change': ExpectedBranchSchema,
      'pr/docs-only': ExpectedBranchSchema,
    }),
  })
  .superRefine((expected, ctx) => {
    for (const [branch, spec] of Object.entries(expected.branches)) {
      for (const route of spec.impact.routes) {
        if (!expected.pages.includes(route)) {
          ctx.addIssue({
            code: 'custom',
            path: ['branches', branch],
            message: `unknown page ${route}`,
          });
        }
      }
      for (const endpoint of spec.impact.endpoints) {
        if (!expected.endpoints.includes(endpoint)) {
          ctx.addIssue({
            code: 'custom',
            path: ['branches', branch],
            message: `unknown endpoint ${endpoint}`,
          });
        }
      }
      for (const finding of spec.findings) {
        if (
          finding.location.route !== undefined &&
          expected.noisyRoutes.includes(finding.location.route)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['branches', branch],
            message: 'a noisy route never has findings',
          });
        }
      }
    }
  });
export type Expected = z.infer<typeof ExpectedSchema>;

/** Path of the repository's `fixtures/expected.json`. */
export const EXPECTED_JSON_PATH = path.join(import.meta.dirname, 'expected.json');

/**
 * Reads and validates the fixture ground truth.
 *
 * @throws BdiffError `INVALID_INPUT` if the file is not valid JSON or doesn't match the schema.
 */
export async function loadExpected(fs: FileSystem, file = EXPECTED_JSON_PATH): Promise<Expected> {
  const text = await fs.readFile(file);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new BdiffError('INVALID_INPUT', `Not valid JSON: ${file}`, {
      cause: error,
      details: { file },
    });
  }
  const parsed = ExpectedSchema.safeParse(json);
  if (!parsed.success) {
    throw new BdiffError('INVALID_INPUT', `Invalid fixture expectations: ${file}`, {
      cause: parsed.error,
      details: { file, issues: z.prettifyError(parsed.error) },
    });
  }
  return parsed.data;
}
