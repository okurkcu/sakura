import { BdiffError } from '../errors/bdiff-error.js';
import type {
  LlmCallContext,
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmTier,
} from '../llm/llm-client.js';
import type { TokenUsage } from '../metrics/run-record.js';

type Scripted =
  | { readonly kind: 'answer'; readonly value: unknown }
  | { readonly kind: 'error'; readonly error: Error };

/** One recorded call to {@link FakeLlmClient.complete}. */
export interface FakeLlmCall {
  readonly purpose: string;
  readonly request: LlmRequest<unknown>;
}

/**
 * Scripted {@link LlmClient} for tests, keyed by `purpose`. Answers are queued per purpose (the
 * last one repeats) and validated against the request's schema like real output (an invalid
 * answer throws `LLM_INVALID_OUTPUT`). Like the real client it checks the budget first and records
 * usage (`usagePerCall`, model `test-model` by default). An unscripted purpose throws.
 */
export class FakeLlmClient implements LlmClient {
  readonly calls: FakeLlmCall[] = [];
  readonly #scripts = new Map<string, Scripted[]>();
  readonly #usage: Omit<TokenUsage, 'model'>;
  readonly #models: Readonly<Record<LlmTier, string>>;

  constructor(
    options: {
      usagePerCall?: Partial<Omit<TokenUsage, 'model'>>;
      models?: Readonly<Record<LlmTier, string>>;
    } = {},
  ) {
    this.#usage = {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      ...options.usagePerCall,
    };
    this.#models = options.models ?? { fast: 'test-model', smart: 'test-model' };
  }

  /** Queues answers (the `data` the model returns) for `purpose`. */
  on(purpose: string, ...answers: unknown[]): this {
    this.#queue(purpose).push(...answers.map((value): Scripted => ({ kind: 'answer', value })));
    return this;
  }

  /** Queues a failure for `purpose`. */
  onError(purpose: string, error: Error): this {
    this.#queue(purpose).push({ kind: 'error', error });
    return this;
  }

  async complete<T>(request: LlmRequest<T>, ctx: LlmCallContext): Promise<LlmResponse<T>> {
    // Settle asynchronously like the real client, so even a budget failure is a rejection.
    await Promise.resolve();
    ctx.budget.assertAvailable();
    this.calls.push({ purpose: request.purpose, request: request });
    const queue = this.#scripts.get(request.purpose) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) {
      throw new BdiffError('INTERNAL', `FakeLlmClient: nothing scripted for "${request.purpose}"`);
    }
    if (next.kind === 'error') {
      throw next.error;
    }
    const usage = ctx.recordLlmUsage(request.purpose, {
      model: this.#models[request.tier],
      ...this.#usage,
    });
    const parsed = request.schema.safeParse(next.value);
    if (!parsed.success) {
      throw new BdiffError('LLM_INVALID_OUTPUT', `Invalid ${request.purpose} output (scripted)`, {
        details: { purpose: request.purpose, problem: parsed.error.message },
      });
    }
    return { data: parsed.data, usage };
  }

  #queue(purpose: string): Scripted[] {
    const queue = this.#scripts.get(purpose) ?? [];
    this.#scripts.set(purpose, queue);
    return queue;
  }
}
