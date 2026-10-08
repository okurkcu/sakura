import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';

import { INTERPRET_PURPOSE, interpretAnswerSchema, interpretPrompt } from './interpret.js';
import type { InterpretPromptInput } from './interpret.js';

const input: InterpretPromptInput = {
  intent: { source: 'commits', title: 'Format the latest order total', body: '' },
  changedFiles: ['M app/api/orders/latest/route.ts'],
  findings: [
    {
      id: 'aaaa',
      kind: 'type-changed',
      severity: 'breaking',
      where: 'GET /api/orders/latest $.total',
      before: 42,
      after: '$42.00',
    },
    {
      id: 'bbbb',
      kind: 'field-added',
      severity: 'warning',
      where: 'GET /api/orders/latest $.currency',
      after: 'USD',
    },
  ],
  coverage: { pages: [], endpoints: ['GET /api/orders/latest'], gaps: [] },
  tier: 'smart',
};

const answer = {
  summary: [
    { text: 'total is now a formatted string.', findingIds: ['aaaa'] },
    { text: 'A currency field was added.', findingIds: ['bbbb'] },
  ],
  unexpected: [{ findingId: 'aaaa', reason: 'The intent only mentions formatting.' }],
  riskLevel: 'high',
  coverageNote: 'The only affected endpoint was probed.',
  reviewerChecklist: ['Check API clients that read total as a number.'],
};

describe('interpretPrompt', () => {
  it('keeps the system prompt static, with two examples, and puts the run in the user turn', () => {
    const schema = interpretAnswerSchema(['aaaa', 'bbbb']);
    const request = interpretPrompt(input, schema);
    const other = interpretPrompt(
      { ...input, intent: { source: 'none', title: '', body: '' }, tier: 'fast' },
      schema,
    );

    expect(request).toMatchObject({ purpose: INTERPRET_PURPOSE, tier: 'smart', schema });
    expect(other.tier).toBe('fast');
    expect(request.system).toBe(other.system);
    expect(request.system.match(/<example>/g)).toHaveLength(2);
    expect(request.system).not.toContain('Format the latest order total');
    const content = request.messages[0]?.content ?? '';
    expect(content).toContain(
      '<intent source="commits">\nTitle: Format the latest order total\n</intent>',
    );
    expect(content).toContain('M app/api/orders/latest/route.ts');
    expect(content).toContain('"id":"aaaa"');
    expect(content).toContain('"endpoints":["GET /api/orders/latest"]');
    expect(other.messages[0]?.content).toContain('no stated intent');
  });

  it('converts the answer schema to a structured output format', () => {
    expect(betaZodOutputFormat(interpretAnswerSchema(['aaaa'])).schema).toMatchObject({
      type: 'object',
    });
  });
});

describe('interpretAnswerSchema', () => {
  const schema = interpretAnswerSchema(['aaaa', 'bbbb']);

  it('accepts an answer that cites known findings', () => {
    expect(schema.safeParse(answer).success).toBe(true);
  });

  it.each([
    [
      'an unknown id in the summary',
      { ...answer, summary: [answer.summary[0], { text: 'x', findingIds: ['zzzz'] }] },
      'summary.1.findingIds.0',
    ],
    [
      'an unknown id in unexpected',
      { ...answer, unexpected: [{ findingId: 'zzzz', reason: 'x' }] },
      'unexpected.0.findingId',
    ],
    [
      'a bullet citing nothing',
      { ...answer, summary: [answer.summary[0], { text: 'x', findingIds: [] }] },
      'summary.1.findingIds',
    ],
    ['a single bullet', { ...answer, summary: [answer.summary[0]] }, 'summary'],
    [
      'four checklist items',
      { ...answer, reviewerChecklist: ['a', 'b', 'c', 'd'] },
      'reviewerChecklist',
    ],
  ])('rejects %s', (_name, invalid, path) => {
    const parsed = schema.safeParse(invalid);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(path);
  });
});
