import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeLlmClient } from './fake-llm-client.js';
import { createTestRunRecorder } from './run-records.js';
import { createTestLogger } from './test-logger.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { LlmCallContext } from '../llm/llm-client.js';

const schema = z.strictObject({ n: z.number() });
const request = (purpose: string) => ({
  purpose,
  system: 's',
  messages: [{ role: 'user' as const, content: 'q' }],
  schema,
  tier: 'fast' as const,
  maxOutputTokens: 100,
});

function context(assertAvailable: () => void = () => undefined) {
  const { recorder } = createTestRunRecorder();
  const ctx: LlmCallContext = {
    budget: { limitUsd: 1, spentUsd: () => recorder.spentUsd(), assertAvailable },
    recordLlmUsage: (purpose, usage) => recorder.recordLlmUsage(purpose, usage),
    signal: new AbortController().signal,
    logger: createTestLogger(),
  };
  return { ctx, recorder };
}

describe('FakeLlmClient', () => {
  it('answers by purpose in order, repeating the last, and records usage', async () => {
    const llm = new FakeLlmClient().on('a', { n: 1 }, { n: 2 });
    const { ctx, recorder } = context();

    const answers = [
      await llm.complete(request('a'), ctx),
      await llm.complete(request('a'), ctx),
      await llm.complete(request('a'), ctx),
    ];

    expect(answers.map((answer) => answer.data.n)).toEqual([1, 2, 2]);
    expect(llm.calls.map((call) => call.purpose)).toEqual(['a', 'a', 'a']);
    expect(recorder.finish({ status: 'success' }).llmUsage).toHaveLength(3);
  });

  it('validates scripted answers like real output', async () => {
    const { ctx } = context();

    await expect(
      new FakeLlmClient().on('a', { n: 'x' }).complete(request('a'), ctx),
    ).rejects.toMatchObject({
      code: 'LLM_INVALID_OUTPUT',
    });
  });

  it('throws scripted errors and refuses unscripted purposes', async () => {
    const llm = new FakeLlmClient().onError('a', new BdiffError('LLM_REFUSED', 'no'));
    const { ctx } = context();

    await expect(llm.complete(request('a'), ctx)).rejects.toMatchObject({ code: 'LLM_REFUSED' });
    await expect(llm.complete(request('b'), ctx)).rejects.toThrow(/nothing scripted for "b"/);
  });

  it('checks the budget first', async () => {
    const llm = new FakeLlmClient().on('a', { n: 1 });
    const { ctx } = context(() => {
      throw new BdiffError('BUDGET_EXCEEDED', 'spent');
    });

    await expect(llm.complete(request('a'), ctx)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(llm.calls).toEqual([]);
  });
});
