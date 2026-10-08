import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInterpretStage, NO_FINDINGS_SUMMARY } from './interpret-stage.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import type { GitHubClient } from '../adapters/github.js';
import type { ApiProbe } from '../domain/api-probe.js';
import type { Finding } from '../domain/finding.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { Workspace } from '../domain/workspace.js';
import { createAnthropicLlmClient } from '../llm/anthropic-client.js';
import { loadLlmConfig } from '../llm/llm-config.js';
import { INTERPRET_PURPOSE } from '../llm/prompts/interpret.js';
import { loadPricingTable } from '../metrics/pricing.js';
import type { LlmUsage, TokenUsage } from '../metrics/run-record.js';
import { FakeExec } from '../testing/fake-exec.js';
import { FakeLlmClient } from '../testing/fake-llm-client.js';
import { createTestStageContext } from '../testing/stage-context.js';

const workspace: Workspace = {
  basePath: '/w/base',
  headPath: '/w/head',
  baseSha: 'b'.repeat(40),
  headSha: 'h'.repeat(40),
  changedFiles: [{ status: 'modified', path: 'app/api/orders/latest/route.ts' }],
};
const impact: ImpactPlan = {
  pages: [],
  endpoints: [],
  notProbed: [],
  confidence: 'high',
  unmappedFiles: [],
  notes: [],
};
const api: ApiProbe = { requests: [], captures: [], notProbed: [] };
const noGitHub: GitHubClient = { getPullRequest: () => Promise.reject(new Error('not used')) };
const commits = () =>
  new FakeExec().on((call) => call.cmd === 'git', {
    stdout: 'Format the latest order total and include its currency\n\n\u001e',
    exitCode: 0,
  });

const typeChanged: Finding = {
  id: 'aaaa',
  kind: 'type-changed',
  severity: 'breaking',
  location: { endpoint: 'GET /api/orders/latest', jsonPath: '$.total' },
  before: 42,
  after: '$42.00',
  evidence: ['/out/a.json'],
};
const textChanged: Finding = {
  id: 'bbbb',
  kind: 'text',
  severity: 'info',
  location: { route: '/login' },
  evidence: [],
};

const answer = (ids: string[]) => ({
  summary: [
    { text: 'total became a formatted string.', findingIds: [ids[0] ?? ''] },
    { text: 'It breaks clients reading a number.', findingIds: [ids[0] ?? ''] },
  ],
  unexpected: [{ findingId: ids[0] ?? '', reason: 'The intent only mentions formatting.' }],
  riskLevel: 'high',
  coverageNote: 'The affected endpoint was probed.',
  reviewerChecklist: [],
});

/** A local repository: the intent comes from the head commits, never from GitHub. */
const target = { repoUrl: '/repos/shop', baseRef: 'main', headRef: 'pr/1' };
const input = (findings: Finding[]) => ({
  target,
  workspace,
  impact,
  ui: [],
  api,
  findings,
});

describe('createInterpretStage', () => {
  it('makes no LLM call without findings and says so, with the coverage', async () => {
    const llm = new FakeLlmClient();
    const exec = new FakeExec();

    const interpretation = await createInterpretStage({ llm, exec, github: noGitHub }).run(
      input([]),
      createTestStageContext().ctx,
    );

    expect(interpretation).toEqual({
      source: 'no-findings',
      summary: [{ text: NO_FINDINGS_SUMMARY, findingIds: [] }],
      unexpected: [],
      riskLevel: 'low',
      coverageNote: 'Probed 0 pages and 0 endpoints; nothing the change can affect was left out.',
      reviewerChecklist: [],
    });
    expect(llm.calls).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it.each([
    ['fast', [textChanged]],
    ['smart', [textChanged, typeChanged]],
  ] as const)('asks the %s tier, with the intent from the head commits', async (tier, findings) => {
    const llm = new FakeLlmClient().on(INTERPRET_PURPOSE, answer([findings[0].id]));

    const interpretation = await createInterpretStage({
      llm,
      exec: commits(),
      github: noGitHub,
    }).run(input([...findings]), createTestStageContext().ctx);

    expect(llm.calls[0]?.request).toMatchObject({ purpose: INTERPRET_PURPOSE, tier });
    expect(llm.calls[0]?.request.messages[0]?.content).toContain(
      'Title: Format the latest order total and include its currency',
    );
    expect(interpretation).toMatchObject({ source: 'llm', riskLevel: 'high', model: 'test-model' });
  });

  it('rejects an answer that cites a finding that does not exist', async () => {
    const llm = new FakeLlmClient().on(INTERPRET_PURPOSE, answer(['zzzz']));

    await expect(
      createInterpretStage({ llm, exec: commits(), github: noGitHub }).run(
        input([typeChanged]),
        createTestStageContext().ctx,
      ),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_OUTPUT' });
  });

  it('retries once through the real client when the model cites an unknown finding, then succeeds', async () => {
    const repoConfig = (file: string) =>
      path.resolve(import.meta.dirname, '../../../../config', file);
    const pricing = await loadPricingTable(nodeFileSystem, repoConfig('pricing.json'));
    const config = {
      ...(await loadLlmConfig(nodeFileSystem, repoConfig('llm.json'), pricing)),
      maxRetries: 0,
    };
    const bodies: unknown[] = [];
    const replies = [answer(['zzzz']), answer(['aaaa'])];
    const fetchFn: typeof fetch = (_url, init) => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      const reply = replies.shift();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: JSON.stringify(reply) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            stop_details: null,
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_creation: null,
              iterations: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const llm = createAnthropicLlmClient({ config, apiKey: 'test-key', fetch: fetchFn });

    const { ctx } = createTestStageContext();
    // The test pricing table only knows test models; this test is about the retry, not the cost.
    const recordLlmUsage = (purpose: string, usage: TokenUsage): LlmUsage => ({
      ...usage,
      purpose,
      costUsd: 0,
    });

    const interpretation = await createInterpretStage({
      llm,
      exec: commits(),
      github: noGitHub,
    }).run(input([typeChanged]), { ...ctx, recordLlmUsage });

    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain('\\"zzzz\\" is not a finding id');
    expect(interpretation).toMatchObject({
      source: 'llm',
      model: 'claude-sonnet-5-5',
      unexpected: [{ findingId: 'aaaa' }],
    });
  });
});
