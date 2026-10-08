import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';

import {
  API_REQUESTS_PURPOSE,
  apiRequestsPrompt,
  GeneratedRequestsSchema,
  MAX_HANDLER_SOURCE_CHARS,
} from './api-requests.js';

const input = {
  method: 'POST',
  path: '/api/feedback',
  file: 'app/api/feedback/route.ts',
  router: 'app',
  source:
    'export async function POST(request: Request) { return Response.json(await request.json()); }',
} as const;

describe('apiRequestsPrompt', () => {
  it('puts the endpoint and source in the user turn and keeps the system prompt static', () => {
    const request = apiRequestsPrompt(input);
    const other = apiRequestsPrompt({ ...input, path: '/api/other', source: 'other' });

    expect(request).toMatchObject({ purpose: API_REQUESTS_PURPOSE, tier: 'fast' });
    expect(request.system).toBe(other.system);
    expect(request.system).not.toContain('/api/feedback');
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.content).toContain('Endpoint: POST /api/feedback');
    expect(request.messages[0]?.content).toContain('App Router route handler');
    expect(request.messages[0]?.content).toContain(
      `<handler_source>\n${input.source}\n</handler_source>`,
    );
  });

  it('cuts a long handler source', () => {
    const request = apiRequestsPrompt({
      ...input,
      router: 'pages',
      source: 'x'.repeat(MAX_HANDLER_SOURCE_CHARS + 500),
    });
    const content = request.messages[0]?.content ?? '';

    expect(content).toContain('Pages Router API route');
    expect(content).toContain('cut by bdiff');
    expect(content.length).toBeLessThan(MAX_HANDLER_SOURCE_CHARS + 500);
  });

  it('converts to a structured output format', () => {
    const format = betaZodOutputFormat(GeneratedRequestsSchema);

    expect(format.schema).toMatchObject({ type: 'object', required: ['requests'] });
  });
});

describe('GeneratedRequestsSchema', () => {
  const valid = {
    description: 'Valid feedback',
    query: [],
    body: { contentType: 'application/json', text: '{"message":"Great","rating":5}' },
  };

  it.each([
    [{ requests: [valid] }, true],
    [{ requests: [valid, { ...valid, body: null }] }, true],
    [{ requests: [] }, false],
    [{ requests: [valid, valid, valid] }, false],
    [{ requests: [{ ...valid, body: { contentType: 'application/json', text: '{oops' } }] }, false],
    [{ requests: [{ ...valid, body: { contentType: 'text/plain', text: '{oops' } }] }, true],
    [{ requests: [{ ...valid, method: 'DELETE' }] }, false],
  ])('validates %j as %s', (answer, ok) => {
    expect(GeneratedRequestsSchema.safeParse(answer).success).toBe(ok);
  });
});
