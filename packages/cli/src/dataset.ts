import { BdiffError } from '@bdiff/core';
import type { FileSystem, RunDataset, Target } from '@bdiff/core';
import { z } from 'zod';

/** The tags every dataset entry has, with their allowed values. */
export const DatasetTagsSchema = z.strictObject({
  difficulty: z.enum(['easy', 'realistic']),
  prType: z.enum(['ui', 'api', 'mixed', 'refactor']),
  author: z.enum(['human', 'agent']),
});
export type DatasetTags = z.infer<typeof DatasetTagsSchema>;
export type DatasetTagName = keyof DatasetTags;

/** Tag names, for `--only` and `stats --by`. */
export const DATASET_TAG_NAMES = DatasetTagsSchema.keyof().options;

/** One pull request of a dataset. */
export const DatasetEntrySchema = z.strictObject({
  /** Unique within the dataset; recorded in `run.json` and the CSV. */
  id: z
    .string()
    .regex(/^[A-Za-z0-9][\w.-]{0,99}$/, 'ids are letters, digits, ".", "_" and "-", at most 100'),
  repoUrl: z.string().min(1),
  /** Optional: a local repository or branch pair has no pull request. */
  prNumber: z.number().int().positive().exactOptional(),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  tags: DatasetTagsSchema,
});
export type DatasetEntry = z.infer<typeof DatasetEntrySchema>;

/** `dataset.json`: the pull requests a batch runs. */
export const DatasetSchema = z
  .strictObject({ entries: z.array(DatasetEntrySchema).min(1) })
  .superRefine((dataset, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of dataset.entries.entries()) {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'id'],
          message: `duplicate id "${entry.id}"`,
        });
      }
      seen.add(entry.id);
    }
  });
export type Dataset = z.infer<typeof DatasetSchema>;

/** One `--only <tag=value>` filter. */
export interface TagFilter {
  readonly tag: DatasetTagName;
  readonly value: string;
}

/**
 * Reads and validates a dataset file.
 *
 * @throws BdiffError `CONFIG_INVALID` for a missing file, invalid JSON or a schema violation, with
 *   every problem in the message.
 */
export async function loadDataset(fs: FileSystem, file: string): Promise<Dataset> {
  if (!(await fs.exists(file))) {
    throw new BdiffError('CONFIG_INVALID', `Dataset not found: ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(file));
  } catch (error) {
    throw new BdiffError('CONFIG_INVALID', `Dataset is not valid JSON: ${file}`, { cause: error });
  }
  const parsed = DatasetSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new BdiffError(
      'CONFIG_INVALID',
      `Invalid dataset ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      { details: { file, problems } },
    );
  }
  return parsed.data;
}

/**
 * Parses `--only` values (`difficulty=easy`).
 *
 * @throws BdiffError `INVALID_INPUT` for an unknown tag or value.
 */
export function parseTagFilters(values: readonly string[]): TagFilter[] {
  return values.map((raw) => {
    const separator = raw.indexOf('=');
    const tag = DATASET_TAG_NAMES.find((name) => name === raw.slice(0, separator));
    if (separator === -1 || tag === undefined) {
      throw new BdiffError(
        'INVALID_INPUT',
        `--only expects <tag>=<value> with a tag of ${DATASET_TAG_NAMES.join(', ')}; got "${raw}"`,
      );
    }
    const value = raw.slice(separator + 1);
    const allowed: readonly string[] = DatasetTagsSchema.shape[tag].options;
    if (!allowed.includes(value)) {
      throw new BdiffError(
        'INVALID_INPUT',
        `--only ${tag} must be one of ${allowed.join(', ')}; got "${value}"`,
      );
    }
    return { tag, value };
  });
}

/** The entries that match every filter, in dataset order. Pure. */
export function selectEntries(
  entries: readonly DatasetEntry[],
  filters: readonly TagFilter[],
): DatasetEntry[] {
  return entries.filter((entry) => filters.every(({ tag, value }) => entry.tags[tag] === value));
}

/** The pipeline target of an entry. Pure. */
export function entryTarget(entry: DatasetEntry): Target {
  return {
    repoUrl: entry.repoUrl,
    baseRef: entry.baseRef,
    headRef: entry.headRef,
    ...(entry.prNumber === undefined ? {} : { prNumber: entry.prNumber }),
  };
}

/** What `run.json` records about an entry. Pure. */
export function entryDataset(entry: DatasetEntry): RunDataset {
  return { id: entry.id, tags: { ...entry.tags } };
}
