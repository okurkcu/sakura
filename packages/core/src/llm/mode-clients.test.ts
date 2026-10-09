import { describe, expect, it } from 'vitest';

import { resolveLlmMode } from './llm-mode.js';
import { CANNED_MODEL, createCannedLlmClient, createOffLlmClient } from './mode-clients.js';
import { apiRequestsPrompt } from './prompts/api-requests.js';
import { interpretAnswerSchema, interpretPrompt } from './prompts/interpret.js';
import type { PromptFinding } from './prompts/interpret.js';
import { createTestStageContext } from '../testing/stage-context.js';

const findings: PromptFinding[] = [
  { id: 'f-breaking', kind: 'type-changed', severity: 'breaking', where: 'GET /api/orders' },
  { id: 'f-info', kind: 'field-added', severity: 'info', where: 'GET /api/orders' },
  { id: 'f-visual', kind: 'visual', severity: 'info', where: '/login' },
];

function interpretRequest(promptFindings: readonly PromptFinding[]) {
  return interpretPrompt(
    {
      intent: { source: 'pr', title: 'Format totals', body: '' },
      changedFiles: ['M app/api/orders/route.ts'],
      findings: promptFindings,
      coverage: { pages: ['/login'], endpoints: ['GET /api/orders'], gaps: [] },
      tier: 'fast',
    },
    interpretAnswerSchema(promptFindings.map((finding) => finding.id)),
  );
}

describe('resolveLlmMode', () => {
  it.each([
    [undefined, true, { mode: 'on', defaulted: false }],
    [undefined, false, { mode: 'off', defaulted: true }],
    ['off', true, { mode: 'off', defaulted: false }],
    ['fake', false, { mode: 'fake', defaulted: false }],
    ['on', false, { mode: 'on', defaulted: false }],
  ] as const)('requested %s, key %s → %o', (requested, hasKey, expected) => {
    expect(resolveLlmMode(requested, hasKey)).toEqual(expected);
  });
});

describe('createCannedLlmClient', () => {
  it('answers the interpret call with a labeled interpretation citing every finding', async () => {
    const { ctx } = createTestStageContext();

    const { data, usage } = await createCannedLlmClient().complete(interpretRequest(findings), ctx);

    expect(data.summary[0]?.findingIds).toEqual(['f-breaking', 'f-info', 'f-visual']);
    expect(data.summary.every((bullet) => bullet.text.startsWith('[fake]'))).toBe(true);
    expect(data.unexpected).toEqual([
      { findingId: 'f-breaking', reason: expect.stringContaining('[fake]') as string },
    ]);
    expect(data.riskLevel).toBe('high');
    expect(data.coverageNote).toContain('no model was called');
    expect(usage).toMatchObject({ model: CANNED_MODEL, costUsd: 0, inputTokens: 0 });
  });

  it('rates a run without breaking findings low and flags nothing', async () => {
    const { ctx } = createTestStageContext();

    const { data } = await createCannedLlmClient().complete(
      interpretRequest(findings.slice(1)),
      ctx,
    );

    expect(data).toMatchObject({ riskLevel: 'low', unexpected: [] });
  });

  it('records no LLM usage and spends nothing', async () => {
    const { ctx } = createTestStageContext();

    await createCannedLlmClient().complete(interpretRequest(findings), ctx);

    expect(ctx.budget.spentUsd()).toBe(0);
  });

  it('proposes one request without query or body for an endpoint', async () => {
    const { ctx } = createTestStageContext();
    const request = apiRequestsPrompt({
      method: 'POST',
      path: '/api/feedback',
      file: 'app/api/feedback/route.ts',
      router: 'app',
      source: 'export async function POST() {}',
    });

    const { data } = await createCannedLlmClient().complete(request, ctx);

    expect(data.requests).toEqual([
      { description: '[fake] request without query or body', query: [], body: null },
    ]);
  });

  it('has no answer for other purposes: LLM_UNAVAILABLE', async () => {
    const { ctx } = createTestStageContext();

    await expect(
      createCannedLlmClient().complete(
        { ...interpretRequest(findings), purpose: 'recipe-repair' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });

  it('respects an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { ctx } = createTestStageContext({ signal: controller.signal });

    await expect(
      createCannedLlmClient().complete(interpretRequest(findings), ctx),
    ).rejects.toThrow();
  });
});

describe('createOffLlmClient', () => {
  it('refuses every call with LLM_UNAVAILABLE, naming the mode', async () => {
    const { ctx } = createTestStageContext();

    await expect(
      createOffLlmClient().complete(interpretRequest(findings), ctx),
    ).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
      details: { llmMode: 'off', purpose: 'interpret' },
    });
  });
});
