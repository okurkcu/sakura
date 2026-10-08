import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaMessage,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages';

import type { LlmCallContext, LlmClient, LlmRequest, LlmResponse } from './llm-client.js';
import type { LlmConfig, LlmTierConfig } from './llm-config.js';
import { parseStructuredOutput } from './structured-output.js';
import { abortError } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { TokenUsage } from '../metrics/run-record.js';

/** Beta header of the scalar `fallbacks: "default"` form of server-side fallback. */
const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** First attempt plus one retry with the validation problem. */
const MAX_ATTEMPTS = 2;

/** Inputs of {@link createAnthropicLlmClient}. */
export interface AnthropicLlmClientOptions {
  readonly config: LlmConfig;
  /**
   * Credentials. When omitted, the SDK resolves them itself: `ANTHROPIC_API_KEY`, then an
   * `ant auth login` profile. Missing credentials only fail a run that actually calls the LLM.
   */
  readonly apiKey?: string;
  /** Replaces the HTTP transport; for tests, so no real request is ever made. */
  readonly fetch?: typeof fetch;
}

/**
 * The real {@link LlmClient}, over the Anthropic SDK's Messages API. Per call: budget check →
 * request (tier's model and effort, cached system prompt, JSON output format, no sampling
 * parameters) → usage recorded for every attempt the API reports, fallback attempts included →
 * refusal check → schema validation, with one retry that quotes the validation problem. Rate
 * limits, overloads and connection errors are retried by the SDK with backoff.
 */
export function createAnthropicLlmClient(options: AnthropicLlmClientOptions): LlmClient {
  let client: Anthropic | undefined;
  const sdk = (): Anthropic => {
    client ??= new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      maxRetries: options.config.maxRetries,
      timeout: options.config.requestTimeoutMs,
    });
    return client;
  };
  return {
    complete: (request, ctx) => complete(sdk, options.config, request, ctx),
  };
}

async function complete<T>(
  sdk: () => Anthropic,
  config: LlmConfig,
  request: LlmRequest<T>,
  ctx: LlmCallContext,
): Promise<LlmResponse<T>> {
  const tier = config.tiers[request.tier];
  const schema = betaZodOutputFormat(request.schema).schema;
  let messages: BetaMessageParam[] = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  for (let attempt = 1; ; attempt += 1) {
    ctx.budget.assertAvailable();
    const response = await send(sdk, tier, request, messages, schema, ctx.signal);
    const recorded = tokenUsagesOf(response, tier.model).map((usage) =>
      ctx.recordLlmUsage(request.purpose, usage),
    );
    const usage = recorded.at(-1);
    ctx.logger.info('llm call', {
      purpose: request.purpose,
      tier: request.tier,
      model: response.model,
      attempt,
      stopReason: response.stop_reason,
      costUsd: recorded.reduce((total, entry) => total + entry.costUsd, 0),
    });

    if (response.stop_reason === 'refusal') {
      throw new BdiffError('LLM_REFUSED', `The model declined the ${request.purpose} request`, {
        details: {
          purpose: request.purpose,
          model: response.model,
          category: response.stop_details?.category ?? null,
        },
      });
    }
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    const result =
      response.stop_reason === 'max_tokens'
        ? ({
            ok: false,
            problem: 'The answer was cut off at the output limit. Answer more concisely.',
          } as const)
        : parseStructuredOutput(text, request.schema);
    if (result.ok && usage !== undefined) {
      return { data: result.data, usage };
    }
    const problem = result.ok ? 'The API reported no usage for this answer.' : result.problem;
    ctx.logger.warn('invalid llm output', { purpose: request.purpose, attempt, problem });
    if (attempt >= MAX_ATTEMPTS) {
      throw new BdiffError(
        'LLM_INVALID_OUTPUT',
        `Invalid ${request.purpose} output after ${String(attempt)} attempts`,
        {
          details: { purpose: request.purpose, problem },
        },
      );
    }
    messages = [
      ...messages,
      ...(text.trim() === '' ? [] : [{ role: 'assistant' as const, content: text }]),
      { role: 'user', content: `${problem}\nReply again with only the corrected JSON.` },
    ];
  }
}

async function send(
  sdk: () => Anthropic,
  tier: LlmTierConfig,
  request: LlmRequest<unknown>,
  messages: BetaMessageParam[],
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<BetaMessage> {
  const params: MessageCreateParamsNonStreaming = {
    model: tier.model,
    max_tokens: request.maxOutputTokens,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { effort: tier.effort, format: { type: 'json_schema', schema } },
    ...(tier.fallbacks === undefined
      ? {}
      : { fallbacks: tier.fallbacks, betas: [SERVER_SIDE_FALLBACK_BETA] }),
  };
  try {
    return await sdk().beta.messages.create(params, { signal });
  } catch (error) {
    throw toBdiffError(error, signal);
  }
}

/**
 * The token usage of every attempt a response reports: each `usage.iterations` entry (the
 * requested model and any fallback model, each billed at its own rates), or the top-level usage
 * when there are no iterations. Pure.
 */
export function tokenUsagesOf(
  response: Pick<BetaMessage, 'model' | 'usage'>,
  requestedModel: string,
): TokenUsage[] {
  const { usage } = response;
  const attempts = (usage.iterations ?? []).filter(
    (entry) => entry.type === 'message' || entry.type === 'fallback_message',
  );
  if (attempts.length > 0) {
    return attempts.map((entry) =>
      tokenUsage(entry.model ?? requestedModel, {
        input: entry.input_tokens,
        output: entry.output_tokens,
        cacheRead: entry.cache_read_input_tokens,
        cacheWrite: entry.cache_creation_input_tokens,
        cacheCreation: entry.cache_creation,
      }),
    );
  }
  return [
    tokenUsage(response.model, {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheCreation: usage.cache_creation,
    }),
  ];
}

function tokenUsage(
  model: string,
  counts: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheCreation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  },
): TokenUsage {
  return {
    model,
    inputTokens: counts.input,
    outputTokens: counts.output,
    cacheReadTokens: counts.cacheRead,
    // Without a TTL breakdown, cache writes are the default 5-minute kind.
    cacheWrite5mTokens: counts.cacheCreation?.ephemeral_5m_input_tokens ?? counts.cacheWrite,
    cacheWrite1hTokens: counts.cacheCreation?.ephemeral_1h_input_tokens ?? 0,
  };
}

/** Maps SDK failures to bdiff errors. Messages never contain credentials. */
function toBdiffError(error: unknown, signal: AbortSignal): BdiffError {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) {
    return abortError(signal);
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new BdiffError(
      'LLM_UNAVAILABLE',
      'The Claude API rejected the credentials; check ANTHROPIC_API_KEY',
      {
        cause: error,
        details: { status: error.status },
      },
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    const requestId: unknown = error.requestID;
    return new BdiffError('LLM_REQUEST_FAILED', `Claude API request failed: ${error.message}`, {
      cause: error,
      details: {
        status: typeof status === 'number' ? status : null,
        requestId: typeof requestId === 'string' ? requestId : null,
      },
    });
  }
  if (error instanceof Anthropic.AnthropicError && /api ?key|auth/i.test(error.message)) {
    return new BdiffError(
      'LLM_UNAVAILABLE',
      'No Claude API credentials: set ANTHROPIC_API_KEY or run `ant auth login`',
      { cause: error },
    );
  }
  return new BdiffError('LLM_REQUEST_FAILED', 'Claude API request failed', { cause: error });
}
