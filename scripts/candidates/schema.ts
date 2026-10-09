import { DatasetEntrySchema } from '@bdiff/cli';
import { z } from 'zod';

/** What a repository's file tree says about how hard it is to set up. */
export const RepoSignalsSchema = z.strictObject({
  /** Directory of the Next.js app (the `package.json` that depends on `next`); `.` is the root. */
  appRoot: z.string().min(1),
  router: z.enum(['app', 'pages', 'both', 'unknown']),
  database: z.enum(['prisma', 'drizzle', 'none']),
  dockerCompose: z.boolean(),
  envExample: z.boolean(),
  /** An env schema file (`env.ts`, `env.mjs`): the app validates its environment. */
  envSchema: z.boolean(),
  monorepo: z.boolean(),
});
export type RepoSignals = z.infer<typeof RepoSignalsSchema>;

/** Whether `bdiff`'s workspace and recipe stages could prepare a candidate (`--validate`). */
export const ValidationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), confidence: z.enum(['high', 'medium', 'low']) }),
  z.strictObject({ status: z.literal('failed'), code: z.string().min(1), message: z.string() }),
]);
export type Validation = z.infer<typeof ValidationSchema>;

/**
 * One candidate pull request: a dataset entry (copy it into `dataset.json` as is: `id`, `repoUrl`,
 * `prNumber`, `baseRef`, `headRef`, `tags`) plus what it was chosen on.
 */
export const CandidateSchema = DatasetEntrySchema.extend({
  title: z.string(),
  url: z.url(),
  author: z.string().min(1),
  mergedAt: z.iso.datetime({ offset: true }),
  changedFiles: z.array(z.string()),
  repo: z.strictObject({
    fullName: z.string().min(1),
    stars: z.number().int().nonnegative(),
    signals: RepoSignalsSchema,
  }),
  /** Higher is a better fit for the experiment (0–1); see `scoreCandidate`. */
  score: z.number().min(0).max(1),
  validation: ValidationSchema.exactOptional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** `candidates.json`. */
export const CandidatesFileSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  /** PRs merged on or after this date were considered. */
  since: z.iso.date(),
  repos: z.number().int().nonnegative(),
  candidates: z.array(CandidateSchema),
});
export type CandidatesFile = z.infer<typeof CandidatesFileSchema>;
