import { z } from 'zod';

import type { LlmClient, LlmRequest, LlmResponse } from './llm-client.js';
import { API_REQUESTS_PURPOSE } from './prompts/api-requests.js';
import type { GeneratedRequests } from './prompts/api-requests.js';
import { INTERPRET_PURPOSE } from './prompts/interpret.js';
import type { InterpretAnswer } from './prompts/interpret.js';
import { throwIfAborted } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Model name recorded for canned answers: no model answered them. */
export const CANNED_MODEL = 'canned';

/** Marks every canned text so it can never pass for a model's answer. */
const MARK = '[fake]';

const PromptFindingsSchema = z.array(
  z.looseObject({ id: z.string(), kind: z.string(), severity: z.string(), where: z.string() }),
);

/**
 * An {@link LlmClient} for `--llm fake`: deterministic, labeled answers without a model, so the
 * full report (and the panel) can be seen without an API key. It answers the interpret call (one
 * summary of the findings it was shown, breaking ones flagged as unexpected) and the API request
 * call (one request without query or body); any other purpose is `LLM_UNAVAILABLE`. Answers are
 * validated against the request's schema like real ones. Nothing is spent or recorded.
 */
export function createCannedLlmClient(): LlmClient {
  return {
    complete: async <T>(request: LlmRequest<T>, ctx: Parameters<LlmClient['complete']>[1]) => {
      await Promise.resolve();
      throwIfAborted(ctx.signal);
      const answer = cannedAnswer(request);
      const parsed = request.schema.safeParse(answer);
      if (!parsed.success) {
        throw new BdiffError(
          'LLM_INVALID_OUTPUT',
          `Canned answer for "${request.purpose}" is invalid`,
          { cause: parsed.error, details: { purpose: request.purpose, llmMode: 'fake' } },
        );
      }
      const response: LlmResponse<T> = {
        data: parsed.data,
        usage: {
          model: CANNED_MODEL,
          purpose: request.purpose,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          costUsd: 0,
        },
      };
      return response;
    },
  };
}

/**
 * An {@link LlmClient} for `--llm off`: every call fails with `LLM_UNAVAILABLE`, which the stages
 * already treat as "no LLM" (generated API requests are not probed, the repair loop stops).
 */
export function createOffLlmClient(): LlmClient {
  return {
    complete: (request) =>
      Promise.reject(
        new BdiffError('LLM_UNAVAILABLE', 'The LLM is off (--llm off)', {
          details: { purpose: request.purpose, llmMode: 'off' },
        }),
      ),
  };
}

function cannedAnswer(request: LlmRequest<unknown>): unknown {
  switch (request.purpose) {
    case INTERPRET_PURPOSE:
      return cannedInterpretation(request);
    case API_REQUESTS_PURPOSE: {
      const answer: GeneratedRequests = {
        requests: [{ description: `${MARK} request without query or body`, query: [], body: null }],
      };
      return answer;
    }
    default:
      throw new BdiffError('LLM_UNAVAILABLE', `No canned answer for "${request.purpose}"`, {
        details: { purpose: request.purpose, llmMode: 'fake' },
      });
  }
}

/** Cites every finding of the prompt's `<findings>` block and flags the breaking ones. */
function cannedInterpretation(request: LlmRequest<unknown>): InterpretAnswer {
  const user = request.messages.findLast((message) => message.role === 'user')?.content ?? '';
  const block = /<findings>\n([\s\S]*?)\n<\/findings>/.exec(user)?.[1];
  let findings: z.infer<typeof PromptFindingsSchema>;
  try {
    findings = PromptFindingsSchema.parse(JSON.parse(block ?? '[]'));
  } catch (error) {
    throw new BdiffError('LLM_INVALID_OUTPUT', 'Canned interpretation found no findings block', {
      cause: error,
      details: { purpose: request.purpose, llmMode: 'fake' },
    });
  }
  const ids = findings.map((finding) => finding.id);
  const breaking = findings.filter((finding) => finding.severity === 'breaking');
  const where = [...new Set(findings.map((finding) => finding.where))].join(', ');
  const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
  return {
    summary: [
      {
        text: `${MARK} ${String(findings.length)} finding(s) on ${where}.`,
        findingIds: ids,
      },
      {
        text: `${MARK} Kinds: ${kinds}. No model read the PR's intent.`,
        findingIds: ids.slice(0, 1),
      },
    ],
    unexpected: breaking.map((finding) => ({
      findingId: finding.id,
      reason: `${MARK} Breaking changes are always flagged in fake mode.`,
    })),
    riskLevel: breaking.length > 0 ? 'high' : 'low',
    coverageNote: `${MARK} Canned interpretation (--llm fake): no model was called. Set ANTHROPIC_API_KEY for a real one.`,
    reviewerChecklist: [],
  };
}
