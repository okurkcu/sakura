import { describe, expect, it } from 'vitest';

import { parseNameStatusZ } from './name-status.js';

const z = (...tokens: string[]) => `${tokens.join('\0')}\0`;

describe('parseNameStatusZ', () => {
  it.each([
    { name: 'no changes', output: '', expected: [] },
    { name: 'added', output: z('A', 'new.ts'), expected: [{ status: 'added', path: 'new.ts' }] },
    { name: 'modified', output: z('M', 'a.ts'), expected: [{ status: 'modified', path: 'a.ts' }] },
    {
      name: 'deleted',
      output: z('D', 'gone.ts'),
      expected: [{ status: 'deleted', path: 'gone.ts' }],
    },
    {
      name: 'type change',
      output: z('T', 'link'),
      expected: [{ status: 'modified', path: 'link' }],
    },
    {
      name: 'exact rename',
      output: z('R100', 'old.ts', 'new.ts'),
      expected: [{ status: 'renamed', path: 'new.ts', oldPath: 'old.ts' }],
    },
    {
      name: 'similar rename',
      output: z('R086', 'lib/orders.ts', 'lib/order-repository.ts'),
      expected: [{ status: 'renamed', path: 'lib/order-repository.ts', oldPath: 'lib/orders.ts' }],
    },
    {
      name: 'copy',
      output: z('C075', 'a.ts', 'b.ts'),
      expected: [{ status: 'added', path: 'b.ts' }],
    },
    {
      name: 'paths with spaces, tabs, quotes and non-ASCII',
      output: z('M', 'docs/read me.md', 'A', 'app/über "x"\tz.tsx'),
      expected: [
        { status: 'modified', path: 'docs/read me.md' },
        { status: 'added', path: 'app/über "x"\tz.tsx' },
      ],
    },
    {
      name: 'several entries in order',
      output: z('M', 'a', 'R100', 'b', 'c', 'D', 'd'),
      expected: [
        { status: 'modified', path: 'a' },
        { status: 'renamed', path: 'c', oldPath: 'b' },
        { status: 'deleted', path: 'd' },
      ],
    },
  ])('parses $name', ({ output, expected }) => {
    expect(parseNameStatusZ(output)).toEqual(expected);
  });

  it.each([
    { name: 'a truncated rename', output: z('R100', 'old.ts') },
    { name: 'a status without a path', output: 'M\0' },
    { name: 'an unknown status', output: z('X', 'a.ts') },
  ])('rejects $name', ({ output }) => {
    expect(() => parseNameStatusZ(output)).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});
