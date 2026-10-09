import { DatasetSchema } from '@bdiff/cli';
import { fixtureDatasetEntries, PR_BRANCHES } from '@bdiff/fixtures';
import { describe, expect, it } from 'vitest';

describe('fixtureDatasetEntries', () => {
  it('is a valid bdiff batch dataset with one entry per PR branch', () => {
    const dataset = DatasetSchema.parse({ entries: fixtureDatasetEntries('/tmp/fixture') });

    expect(dataset.entries.map((entry) => entry.headRef)).toEqual([...PR_BRANCHES]);
    expect(dataset.entries.map((entry) => [entry.id, entry.tags.prType])).toEqual([
      ['ui-change', 'ui'],
      ['api-breaking', 'api'],
      ['refactor-no-change', 'refactor'],
      ['docs-only', 'refactor'],
    ]);
  });
});
