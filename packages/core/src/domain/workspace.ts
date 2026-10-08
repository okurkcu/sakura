import { z } from 'zod';

const pathSchema = z.string().min(1);

/** A file changed between the merge-base and head, as reported by `git diff --name-status -M`. */
export const ChangedFileSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['added', 'modified', 'deleted']), path: pathSchema }),
  z.object({ status: z.literal('renamed'), path: pathSchema, oldPath: pathSchema }),
]);
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** Base and head source trees on disk, and what changed between them. */
export const WorkspaceSchema = z.object({
  basePath: pathSchema,
  headPath: pathSchema,
  baseSha: z.string().regex(/^[0-9a-f]{40}$/, 'expected a full 40-character git SHA'),
  headSha: z.string().regex(/^[0-9a-f]{40}$/, 'expected a full 40-character git SHA'),
  changedFiles: z.array(ChangedFileSchema),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
