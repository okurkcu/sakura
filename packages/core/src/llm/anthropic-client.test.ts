import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAnthropicLlmClient, tokenUsagesOf } from './anthropic-client.js';
import type { LlmCallContext, LlmRequest } from './llm-client.js';
import { loadLlmConfig } from './llm-config.js';
import type { LlmConfig } from './llm-config.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { createCostCalculator, loadPricingTable } from '../metrics/pricing.js';
import type { CostCalculator, PricingTable } from '../metrics/pricing.js';
import { createRunRecorder } from '../metrics/run-recorder.js';
import { runPipeline } from '../pipeline/run-pipeline.js';
import type { Budget } from '../pipeline/stage.js';
import { createStubStages } from '../pipeline/stub-stages.js';
import { FakeClock } from '../testing/fake-clock.js';
import { createMemoryMetricsStore } from '../testing/memory-metrics-store.js';
import { TEST_RUN_ID, TEST_TARGET } from '../testing/run-records.js';
import { createTestLogger } from '../testing/test-logger.js';

const repoConfig = (file: string) => path.resolve(import.meta.dirname, '../../../../config', file);

let pricing: PricingTable;
let costs: CostCalculator;
let config: LlmConfig;

beforeAll(async () => {
  pricing = await loadPricingTable(nodeFileSystem, repoConfig('pricing.json'));
  costs = createCostCalculator(pricing);
  config = {
    ...(await loadLlmConfig(nodeFileSystem, repoConfig('llm.json'), pricing)),
    maxRetries: 1,
  };
});

const AnswerSchema = z.strictObject({
  verdict: z.enum(['same', 'changed']),
  reason: z.string().min(3),
});

const request = (
  overrides: Partial<LlmRequest<z.infer<typeof AnswerSchema>>> = {},
): LlmRequest<z.infer<typeof AnswerSchema>> => ({
  purpose: 'interpret',
  system: 'You compare two app versions.',
  messages: [{ role: 'user', content: 'Did the login page change?' }],
  schema: AnswerSchema,
  tier: 'fast',
  maxOutputTokens: 4_000,
  ...overrides,
});

interface FakeResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/** A fake transport: answers with `responses` in order and records every request. */
function fakeApi(...responses: FakeResponse[]) {
  const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchFn: typeof fetch = (_input, init) => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    requests.push({ body: body as Record<string, unknown>, headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fake API: no response left'));
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...next.headers },
      }),
    );
  };
  return { fetchFn, requests };
}

const usage = (overrides: Record<string, unknown> = {}) => ({
  input_tokens: 1_000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  iterations: null,
  ...overrides,
});

const message = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: usage(),
  ...overrides,
});

const VALID = JSON.stringify({ verdict: 'changed', reason: 'new button' });

function context(budget?: Partial<Budget>, signal = new AbortController().signal) {
  const recorder = createRunRecorder({
    runId: TEST_RUN_ID,
    target: TEST_TARGET,
    toolVersion: 't',
    clock: new FakeClock(),
    costs,
  });
  const ctx: LlmCallContext = {
    budget: {
      limitUsd: 1,
      spentUsd: () => recorder.spentUsd(),
      assertAvailable: () => undefined,
      ...budget,
    },
    recordLlmUsage: (purpose, tokens) => recorder.recordLlmUsage(purpose, tokens),
    signal,
    logger: createTestLogger(),
  };
  return { ctx, recorder };
}

async function failure(promise: Promise<unknown>): Promise<BdiffError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof BdiffError)) {
    throw new Error(`expected a BdiffError, got ${String(error)}`);
  }
  return error;
}

describe('createAnthropicLlmClient', () => {
  it('sends the tier model and effort, a cached system prompt and the JSON schema, and validates the answer', async () => {
    const api = fakeApi({
      body: message(VALID, {
        usage: usage({
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
        }),
      }),
    });
    const { ctx, recorder } = context();

    const result = await createAnthropicLlmClient({
      config,
      apiKey: 'test-key',
      fetch: api.fetchFn,
    }).complete(request(), ctx);

    expect(result.data).toEqual({ verdict: 'changed', reason: 'new button' });
    const body = api.requests[0]?.body ?? {};
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 4_000,
      system: [
        {
          type: 'text',
          text: 'You compare two app versions.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'Did the login page change?' }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(JSON.stringify(body)).toContain('"verdict"');
    for (const key of ['temperature', 'top_p', 'top_k', 'fallbacks', 'thinking']) {
      expect(body).not.toHaveProperty(key);
    }
    // 1000 in × $0.10 + 200 out × $0.50 + 500 cache-write × $0.125 per MTok
    expect(result.usage).toMatchObject({
      purpose: 'interpret',
      model: 'claude-haiku-5-5',
      cacheWrite5mTokens: 500,
    });
    expect(result.usage.costUsd).toBeCloseTo((1_000 * 0.1 + 200 * 0.5 + 500 * 0.125) / 1e6, 12);
    expect(recorder.finish({ status: 'success' }).llmUsage).toEqual([result.usage]);
  });

  it('turns on server-side fallback for the smart tier and records every attempt at its own model', async () => {
    const api = fakeApi({
      body: message(VALID, {
        model: 'claude-sonnet-5',
        usage: usage({
          iterations: [
            {
              type: 'message',
              model: 'claude-sonnet-5-5',
              input_tokens: 800,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_creation: null,
            },
            {
              type: 'fallback_message',
              model: 'claude-sonnet-5',
              input_tokens: 800,
              output_tokens: 150,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_creation: null,
            },
          ],
        }),
      }),
    });
    const { ctx, recorder } = context();

    const result = await createAnthropicLlmClient({
      config,
      apiKey: 'k',
      fetch: api.fetchFn,
    }).complete(request({ tier: 'smart' }), ctx);

    expect(api.requests[0]?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      fallbacks: 'default',
    });
    expect(api.requests[0]?.headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    const recorded = recorder.finish({ status: 'success' }).llmUsage;
    expect(recorded.map((entry) => [entry.model, entry.inputTokens, entry.outputTokens])).toEqual([
      ['claude-sonnet-5-5', 800, 0],
      ['claude-sonnet-5', 800, 150],
    ]);
    expect(result.usage.model).toBe('claude-sonnet-5');
  });

  it('retries once with the validation problem after invalid JSON, then succeeds', async () => {
    const api = fakeApi({ body: message('{"verdict": "changed",') }, { body: message(VALID) });
    const { ctx, recorder } = context();

    const result = await createAnthropicLlmClient({
      config,
      apiKey: 'k',
      fetch: api.fetchFn,
    }).complete(request(), ctx);

    expect(result.data.verdict).toBe('changed');
    expect(api.requests).toHaveLength(2);
    const retry = api.requests[1]?.body.messages as { role: string; content: string }[];
    expect(retry.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user']);
    expect(retry[2]?.content).toMatch(/not valid JSON[\s\S]*corrected JSON/);
    expect(recorder.finish({ status: 'success' }).llmUsage).toHaveLength(2);
  });

  it('fails with LLM_INVALID_OUTPUT after one retry (invalid JSON → retry → typed error)', async () => {
    const api = fakeApi({ body: message('not json') }, { body: message('still not json') });
    const { ctx, recorder } = context();

    const error = await failure(
      createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
        request(),
        ctx,
      ),
    );

    expect(error).toMatchObject({ code: 'LLM_INVALID_OUTPUT', details: { purpose: 'interpret' } });
    expect(api.requests).toHaveLength(2);
    expect(recorder.finish({ status: 'success' }).llmUsage).toHaveLength(2);
  });

  it('quotes schema violations the API cannot enforce, such as string length', async () => {
    const api = fakeApi(
      { body: message(JSON.stringify({ verdict: 'same', reason: 'x' })) },
      { body: message(VALID) },
    );
    const { ctx } = context();

    await createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
      request(),
      ctx,
    );

    const retry = api.requests[1]?.body.messages as { content: string }[];
    expect(retry.at(-1)?.content).toMatch(/does not match the required schema[\s\S]*reason/);
  });

  it('treats an answer cut off at max_tokens as invalid and retries', async () => {
    const api = fakeApi(
      { body: message('{"verdict":', { stop_reason: 'max_tokens' }) },
      { body: message(VALID) },
    );
    const { ctx } = context();

    await createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
      request(),
      ctx,
    );

    const retry = api.requests[1]?.body.messages as { content: string }[];
    expect(retry.at(-1)?.content).toContain('cut off at the output limit');
  });

  it('fails with LLM_REFUSED on a refusal, records its usage, and does not retry', async () => {
    const api = fakeApi({
      body: message('', {
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      }),
    });
    const { ctx, recorder } = context();

    const error = await failure(
      createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
        request(),
        ctx,
      ),
    );

    expect(error).toMatchObject({ code: 'LLM_REFUSED', details: { category: 'cyber' } });
    expect(api.requests).toHaveLength(1);
    expect(recorder.finish({ status: 'success' }).llmUsage).toHaveLength(1);
  });

  it('enforces the budget before sending: no request once the budget is spent', async () => {
    const api = fakeApi({ body: message(VALID) });
    const { ctx } = context({
      assertAvailable: () => {
        throw new BdiffError('BUDGET_EXCEEDED', 'spent');
      },
    });

    const error = await failure(
      createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
        request(),
        ctx,
      ),
    );

    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(api.requests).toHaveLength(0);
  });

  it('checks the budget again before the retry', async () => {
    const api = fakeApi({ body: message('nope') }, { body: message(VALID) });
    let checks = 0;
    const { ctx } = context({
      assertAvailable: () => {
        checks += 1;
        if (checks > 1) {
          throw new BdiffError('BUDGET_EXCEEDED', 'spent by the first attempt');
        }
      },
    });

    const error = await failure(
      createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
        request(),
        ctx,
      ),
    );

    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(api.requests).toHaveLength(1);
  });

  it('lets the SDK retry overloads and server errors', async () => {
    const retryNow = { 'retry-after-ms': '0' };
    const api = fakeApi(
      {
        status: 529,
        body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        headers: retryNow,
      },
      { body: message(VALID) },
    );
    const { ctx } = context();

    const result = await createAnthropicLlmClient({
      config,
      apiKey: 'k',
      fetch: api.fetchFn,
    }).complete(request(), ctx);

    expect(result.data.verdict).toBe('changed');
    expect(api.requests).toHaveLength(2);
  });

  it.each([
    { status: 401, type: 'authentication_error', code: 'LLM_UNAVAILABLE' },
    { status: 403, type: 'permission_error', code: 'LLM_UNAVAILABLE' },
    { status: 400, type: 'invalid_request_error', code: 'LLM_REQUEST_FAILED' },
  ])('maps HTTP $status to $code', async ({ status, type, code }) => {
    const api = fakeApi({ status, body: { type: 'error', error: { type, message: 'nope' } } });
    const { ctx } = context();

    const error = await failure(
      createAnthropicLlmClient({
        config,
        apiKey: 'sk-ant-test-SECRET-123',
        fetch: api.fetchFn,
      }).complete(request(), ctx),
    );

    expect(error.code).toBe(code);
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain('SECRET');
  });

  it('reports missing credentials as LLM_UNAVAILABLE, without sending a request', async () => {
    // No key, token or profile anywhere the SDK looks.
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE']) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('HOME', path.join(import.meta.dirname, 'no-such-home'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(import.meta.dirname, 'no-such-config'));
    const api = fakeApi({ body: message(VALID) });
    const { ctx } = context();
    try {
      const error = await failure(
        createAnthropicLlmClient({ config, fetch: api.fetchFn }).complete(request(), ctx),
      );

      expect(error.code).toBe('LLM_UNAVAILABLE');
      expect(error.message).toContain('ANTHROPIC_API_KEY');
      expect(api.requests).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports the status and request id of a failed request', async () => {
    const api = fakeApi({
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
    });
    const { ctx } = context();

    const error = await failure(
      createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
        request(),
        ctx,
      ),
    );

    expect(error.details).toMatchObject({ status: 400, requestId: 'req_test' });
  });

  it('stops when the run aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = fakeApi({ body: message(VALID) });
    const { ctx } = context(undefined, controller.signal);

    const error = await failure(
      createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn }).complete(
        request(),
        ctx,
      ),
    );

    expect(error.code).toBe('ABORTED');
  });

  it('puts usage and cost in the run record', async () => {
    const api = fakeApi({ body: message(VALID, { model: 'claude-sonnet-5-5' }) });
    const llm = createAnthropicLlmClient({ config, apiKey: 'k', fetch: api.fetchFn });
    const store = createMemoryMetricsStore();
    const stubs = createStubStages();

    const { result } = await runPipeline(
      TEST_TARGET,
      {
        ...stubs,
        interpret: {
          name: 'interpret',
          run: async (input, ctx) => {
            await llm.complete(request({ tier: 'smart' }), ctx);
            return stubs.interpret.run(input, ctx);
          },
        },
      },
      {
        clock: new FakeClock(),
        fs: nodeFileSystem,
        logger: createTestLogger(),
        costs,
        outDir: '/unused',
        toolVersion: 't',
        timeoutMs: 60_000,
        budgetUsd: 1,
        signal: new AbortController().signal,
        runId: TEST_RUN_ID,
        store,
      },
    );

    expect(result.record.status).toBe('success');
    const written = store.written[0];
    expect(written?.llmUsage).toEqual([
      expect.objectContaining({
        purpose: 'interpret',
        model: 'claude-sonnet-5-5',
        inputTokens: 1_000,
        outputTokens: 200,
      }),
    ]);
    // 1000 × $2 + 200 × $10 per MTok = $0.004
    expect(written?.totals).toMatchObject({ llmCalls: 1, llmCostUsd: 0.004 });
  });
});

describe('tokenUsagesOf', () => {
  it('uses the top-level usage without iterations, defaulting cache writes to 5 minutes', () => {
    expect(
      tokenUsagesOf(
        {
          model: 'm',
          usage: usage({
            cache_creation: null,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 3,
          }),
        } as never,
        'm',
      ),
    ).toEqual([
      {
        model: 'm',
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 3,
        cacheWrite5mTokens: 7,
        cacheWrite1hTokens: 0,
      },
    ]);
  });

  it('splits 1-hour cache writes', () => {
    const [entry] = tokenUsagesOf(
      {
        model: 'm',
        usage: usage({
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
        }),
      } as never,
      'm',
    );

    expect(entry).toMatchObject({ cacheWrite5mTokens: 4, cacheWrite1hTokens: 6 });
  });
});
