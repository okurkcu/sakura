import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { nodeFileSystem } from '@bdiff/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DatasetSchema,
  entryDataset,
  entryTarget,
  loadDataset,
  parseTagFilters,
  selectEntries,
} from './dataset.js';
import type { DatasetEntry } from './dataset.js';

const entry = (id: string, overrides: Partial<DatasetEntry> = {}): DatasetEntry => ({
  id,
  repoUrl: 'https://github.com/acme/shop.git',
  baseRef: 'main',
  headRef: `pr/${id}`,
  tags: { difficulty: 'easy', prType: 'ui', author: 'human' },
  ...overrides,
});

describe('DatasetSchema', () => {
  it('accepts entries with or without a PR number', () => {
    expect(
      DatasetSchema.parse({ entries: [entry('a', { prNumber: 7 }), entry('local')] }).entries,
    ).toHaveLength(2);
  });

  it.each([
    ['no entries', { entries: [] }, /entries/],
    ['a duplicate id', { entries: [entry('a'), entry('a')] }, /duplicate id "a"/],
    ['an id with a slash', { entries: [entry('a/b')] }, /ids are letters/],
    [
      'an unknown tag value',
      {
        entries: [
          entry('a', { tags: { difficulty: 'hard', prType: 'ui', author: 'human' } as never }),
        ],
      },
      /difficulty/,
    ],
    ['an extra field', { entries: [{ ...entry('a'), notes: 'x' }] }, /notes/],
  ])('rejects %s', (_name, value, problem) => {
    const parsed = DatasetSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
    ).toMatch(problem);
  });
});

describe('loadDataset', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bdiff-dataset-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a valid dataset', async () => {
    const file = path.join(dir, 'dataset.json');
    await writeFile(file, JSON.stringify({ entries: [entry('a')] }));

    expect((await loadDataset(nodeFileSystem, file)).entries[0]?.id).toBe('a');
  });

  it.each([
    ['a missing file', undefined, /Dataset not found/],
    ['invalid JSON', '{', /not valid JSON/],
    [
      'a schema violation',
      JSON.stringify({ entries: [entry('a'), entry('a')] }),
      /entries\.1\.id: duplicate id "a"/,
    ],
  ])('fails with CONFIG_INVALID for %s', async (_name, content, message) => {
    const file = path.join(dir, 'dataset.json');
    if (content !== undefined) {
      await writeFile(file, content);
    }

    await expect(loadDataset(nodeFileSystem, file)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message,
    });
  });
});

describe('parseTagFilters / selectEntries', () => {
  const entries = [
    entry('a'),
    entry('b', { tags: { difficulty: 'realistic', prType: 'ui', author: 'agent' } }),
    entry('c', { tags: { difficulty: 'realistic', prType: 'api', author: 'agent' } }),
  ];

  it('keeps the entries that match every filter, in order', () => {
    expect(selectEntries(entries, []).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(
      selectEntries(entries, parseTagFilters(['difficulty=realistic'])).map((e) => e.id),
    ).toEqual(['b', 'c']);
    expect(
      selectEntries(entries, parseTagFilters(['difficulty=realistic', 'prType=ui'])).map(
        (e) => e.id,
      ),
    ).toEqual(['b']);
  });

  it.each([
    ['difficulty', /expects <tag>=<value>/],
    ['size=large', /tag of difficulty, prType, author/],
    ['author=robot', /author must be one of human, agent/],
  ])('rejects "%s"', (raw, message) => {
    expect(() => parseTagFilters([raw])).toThrow(message);
  });
});

describe('entryTarget / entryDataset', () => {
  it('maps an entry to a pipeline target and its run.json dataset', () => {
    expect(entryTarget(entry('a', { prNumber: 7 }))).toEqual({
      repoUrl: 'https://github.com/acme/shop.git',
      baseRef: 'main',
      headRef: 'pr/a',
      prNumber: 7,
    });
    expect(entryTarget(entry('b'))).not.toHaveProperty('prNumber');
    expect(entryDataset(entry('a'))).toEqual({
      id: 'a',
      tags: { difficulty: 'easy', prType: 'ui', author: 'human' },
    });
  });
});
