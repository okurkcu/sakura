import { describe, expect, it } from 'vitest';

import { FindingSchema } from './finding.js';
import { JsonObjectSchema } from './json.js';
import { ProbeRunSchema, StageNameSchema } from './stage.js';
import { TargetSchema } from './target.js';
import { ChangedFileSchema, WorkspaceSchema } from './workspace.js';

const sha = (char: string) => char.repeat(40);

describe('TargetSchema', () => {
  const valid = { repoUrl: 'https://github.com/acme/app.git', baseRef: 'main', headRef: 'pr/1' };

  it.each([
    { name: 'minimal', input: valid },
    { name: 'local path', input: { ...valid, repoUrl: '/tmp/fixture-repo' } },
    { name: 'with PR metadata', input: { ...valid, prNumber: 42, prTitle: 'Fix', prBody: '' } },
  ])('accepts $name', ({ input }) => {
    expect(TargetSchema.parse(input)).toEqual(input);
  });

  it.each([
    { name: 'empty baseRef', input: { ...valid, baseRef: '' } },
    { name: 'whitespace headRef', input: { ...valid, headRef: '   ' } },
    {
      name: 'ref that git would parse as an option',
      input: { ...valid, headRef: '--upload-pack=x' },
    },
    { name: 'repoUrl that git would parse as an option', input: { ...valid, repoUrl: '-oProxy' } },
    { name: 'zero prNumber', input: { ...valid, prNumber: 0 } },
    { name: 'fractional prNumber', input: { ...valid, prNumber: 1.5 } },
    { name: 'missing headRef', input: { repoUrl: valid.repoUrl, baseRef: 'main' } },
  ])('rejects $name', ({ input }) => {
    expect(TargetSchema.safeParse(input).success).toBe(false);
  });

  it('trims refs', () => {
    expect(TargetSchema.parse({ ...valid, baseRef: ' main ' }).baseRef).toBe('main');
  });
});

describe('ChangedFileSchema', () => {
  it.each([
    { status: 'added', path: 'a.ts' },
    { status: 'modified', path: 'a.ts' },
    { status: 'deleted', path: 'a.ts' },
    { status: 'renamed', path: 'b.ts', oldPath: 'a.ts' },
  ])('accepts $status', (input) => {
    expect(ChangedFileSchema.parse(input)).toEqual(input);
  });

  it.each([
    { name: 'renamed without oldPath', input: { status: 'renamed', path: 'b.ts' } },
    { name: 'unknown status', input: { status: 'copied', path: 'a.ts' } },
    { name: 'empty path', input: { status: 'added', path: '' } },
  ])('rejects $name', ({ input }) => {
    expect(ChangedFileSchema.safeParse(input).success).toBe(false);
  });
});

describe('WorkspaceSchema', () => {
  const valid = {
    basePath: '/w/base',
    headPath: '/w/head',
    baseSha: sha('a'),
    headSha: sha('b'),
    changedFiles: [{ status: 'modified', path: 'app/page.tsx' }],
  };

  it('accepts a workspace', () => {
    expect(WorkspaceSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    { name: 'short sha', input: { ...valid, baseSha: 'abc123' } },
    { name: 'uppercase sha', input: { ...valid, headSha: 'A'.repeat(40) } },
  ])('rejects $name', ({ input }) => {
    expect(WorkspaceSchema.safeParse(input).success).toBe(false);
  });
});

describe('FindingSchema', () => {
  const valid = {
    id: 'f-1',
    kind: 'type-changed',
    severity: 'breaking',
    location: { endpoint: 'GET /api/orders/latest', jsonPath: '$.total' },
    before: 42,
    after: '42.00',
    evidence: ['api/head/orders-latest.json'],
  };

  it.each([
    { name: 'API finding', input: valid },
    {
      name: 'visual finding with bbox',
      input: {
        id: 'f-2',
        kind: 'visual',
        severity: 'info',
        location: { route: '/login', bbox: { x: 0, y: 10, width: 100, height: 20 } },
        evidence: ['ui/head/login.png'],
      },
    },
  ])('accepts $name', ({ input }) => {
    expect(FindingSchema.parse(input)).toEqual(input);
  });

  it.each([
    { name: 'unknown kind', input: { ...valid, kind: 'renamed' } },
    { name: 'unknown severity', input: { ...valid, severity: 'critical' } },
    { name: 'empty id', input: { ...valid, id: '' } },
    {
      name: 'negative bbox',
      input: { ...valid, location: { bbox: { x: -1, y: 0, width: 1, height: 1 } } },
    },
    {
      name: 'zero-size bbox',
      input: { ...valid, location: { bbox: { x: 0, y: 0, width: 0, height: 1 } } },
    },
    { name: 'non-JSON before value', input: { ...valid, before: () => 1 } },
  ])('rejects $name', ({ input }) => {
    expect(FindingSchema.safeParse(input).success).toBe(false);
  });
});

describe('enums', () => {
  it('lists the pipeline stages in execution order', () => {
    expect(StageNameSchema.options).toEqual([
      'workspace',
      'recipe',
      'environment',
      'impact',
      'probe-ui',
      'probe-api',
      'diff',
      'interpret',
      'report',
      'metrics',
    ]);
  });

  it('has three probe runs', () => {
    expect(ProbeRunSchema.options).toEqual(['baseA', 'baseB', 'head']);
  });
});

describe('JsonObjectSchema', () => {
  it('accepts nested JSON and rejects non-JSON values', () => {
    expect(JsonObjectSchema.safeParse({ a: [1, 'x', null, { b: true }] }).success).toBe(true);
    expect(JsonObjectSchema.safeParse({ a: new Date() }).success).toBe(false);
    expect(JsonObjectSchema.safeParse({ a: undefined }).success).toBe(false);
  });
});
