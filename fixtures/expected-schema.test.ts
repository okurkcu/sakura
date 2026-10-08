import { nodeFileSystem } from '@bdiff/core';
import type { FileSystem } from '@bdiff/core';
import { describe, expect, it } from 'vitest';

import { BRANCH_SPECS, PR_BRANCHES } from './branches.js';
import { ExpectedSchema, loadExpected } from './expected-schema.js';

const fsWith = (text: string): FileSystem => ({
  ...nodeFileSystem,
  readFile: () => Promise.resolve(text),
});

describe('fixtures/expected.json', () => {
  it('validates against ExpectedSchema', async () => {
    const expected = await loadExpected(nodeFileSystem);

    expect(Object.keys(expected.branches).sort()).toEqual([...PR_BRANCHES].sort());
  });

  it('matches the CLAUDE.md ground truth', async () => {
    const { branches, noisyRoutes } = await loadExpected(nodeFileSystem);

    expect(
      branches['pr/ui-change'].findings.every((finding) => finding.location.route === '/login'),
    ).toBe(true);
    const apiFindings = branches['pr/api-breaking'].findings;
    expect(apiFindings.find((finding) => finding.location.jsonPath === '$.total')).toMatchObject({
      kind: 'type-changed',
      severity: 'breaking',
    });
    expect(apiFindings.find((finding) => finding.location.jsonPath === '$.currency')).toMatchObject(
      {
        kind: 'field-added',
      },
    );
    expect(branches['pr/refactor-no-change'].findings).toEqual([]);
    expect(branches['pr/docs-only'].impact.skip).toEqual({ reason: 'docs-only' });
    expect(branches['pr/refactor-no-change'].impact.routes).toEqual(
      expect.arrayContaining(noisyRoutes),
    );
  });

  it('lists every file a branch deletes as deleted or renamed away', async () => {
    const { branches } = await loadExpected(nodeFileSystem);

    for (const spec of BRANCH_SPECS) {
      const changes = branches[spec.branch].changedFiles;
      for (const deleted of spec.deletes) {
        expect(
          changes.some(
            (file) => file.path === deleted || ('oldPath' in file && file.oldPath === deleted),
          ),
        ).toBe(true);
      }
    }
  });
});

describe('loadExpected', () => {
  const valid = async () =>
    JSON.parse(
      await nodeFileSystem.readFile(new URL('./expected.json', import.meta.url).pathname),
    ) as Record<string, unknown>;

  it('rejects malformed JSON', async () => {
    await expect(loadExpected(fsWith('{'), 'expected.json')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it.each([
    {
      name: 'a missing branch',
      mutate: (json: Record<string, unknown>) => {
        const branches = { ...(json.branches as Record<string, unknown>) };
        delete branches['pr/docs-only'];
        return { ...json, branches };
      },
    },
    {
      name: 'an unknown finding kind',
      mutate: (json: Record<string, unknown>) =>
        JSON.parse(JSON.stringify(json).replace('"type-changed"', '"renamed"')) as Record<
          string,
          unknown
        >,
    },
    {
      name: 'an impact route that is not a page',
      mutate: (json: Record<string, unknown>) =>
        JSON.parse(
          JSON.stringify(json)
            .replace('"routes": ["/login"]', '"routes": ["/nope"]')
            .replace('"routes":["/login"]', '"routes":["/nope"]'),
        ) as Record<string, unknown>,
    },
    {
      name: 'a finding on the noisy page',
      mutate: (json: Record<string, unknown>) =>
        JSON.parse(
          JSON.stringify(json).replace(
            '"location":{"route":"/login"}',
            '"location":{"route":"/dashboard"}',
          ),
        ) as Record<string, unknown>,
    },
    {
      name: 'a skipped branch with findings',
      mutate: (json: Record<string, unknown>) =>
        JSON.parse(
          JSON.stringify(json).replace(
            '"impact":{"skip":{"reason":"docs-only"},"routes":[],"endpoints":[]},"findings":[]',
            '"impact":{"skip":{"reason":"docs-only"},"routes":[],"endpoints":[]},"findings":[{"kind":"text","location":{"route":"/"}}]',
          ),
        ) as Record<string, unknown>,
    },
  ])('rejects $name', async ({ mutate }) => {
    const mutated = mutate(await valid());

    expect(ExpectedSchema.safeParse(await valid()).success).toBe(true);
    expect(ExpectedSchema.safeParse(mutated).success).toBe(false);
    await expect(
      loadExpected(fsWith(JSON.stringify(mutated)), 'expected.json'),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
