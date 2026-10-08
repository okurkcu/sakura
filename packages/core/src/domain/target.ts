import { z } from 'zod';

/**
 * A string that is passed to git as a positional argument. A leading "-" would be parsed as an
 * option, so it is rejected.
 */
const gitArgument = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .refine((value) => !value.startsWith('-'), `${label} must not start with "-"`);

/** What to compare: a repository and the two refs of a pull request. */
export const TargetSchema = z.object({
  /** HTTPS URL or local path of the repository. */
  repoUrl: gitArgument('repoUrl'),
  baseRef: gitArgument('baseRef'),
  headRef: gitArgument('headRef'),
  prNumber: z.number().int().positive().exactOptional(),
  prTitle: z.string().exactOptional(),
  prBody: z.string().exactOptional(),
});
export type Target = z.infer<typeof TargetSchema>;
