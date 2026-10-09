import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';

import { RECIPE_REPAIR_PURPOSE, recipeRepairPrompt } from './recipe-repair.js';
import type { RecipeRepairPromptInput } from './recipe-repair.js';
import { RecipePatchSchema } from '../../domain/setup-repair.js';
import { STUB_RECIPE } from '../../testing/stub-stages.js';

const input: RecipeRepairPromptInput = {
  failure: { stage: 'environment', code: 'SETUP_BUILD_FAILED', message: 'head: build failed' },
  attempt: 2,
  maxAttempts: 3,
  recipe: STUB_RECIPE,
  previousAttempts: [
    {
      attempt: 1,
      patch: null,
      outcome: 'no-patch',
      errorCode: 'LLM_REQUEST_FAILED',
    },
  ],
  tree: ['app/', 'package.json', 'server.mjs'],
  treeCut: 4,
  documents: [{ path: 'README.md', content: '## Setup\nSet SESSION_SECRET.' }],
  logTail: ['Error: SESSION_SECRET must be set'],
  tier: 'fast',
};

describe('recipeRepairPrompt', () => {
  it('puts the run in the user turn and keeps the system prompt static', () => {
    const request = recipeRepairPrompt(input);
    const other = recipeRepairPrompt({ ...input, logTail: ['other'], tier: 'smart' });

    expect(request).toMatchObject({ purpose: RECIPE_REPAIR_PURPOSE, tier: 'fast' });
    expect(other.tier).toBe('smart');
    expect(request.system).toBe(other.system);
    expect(request.schema).toBe(RecipePatchSchema);
    const user = request.messages[0]?.content ?? '';
    expect(user).toContain('<failure attempt="2" of="3">\nSetup failed (SETUP_BUILD_FAILED)');
    expect(user).toContain('"installCmd"');
    expect(user).toContain('"errorCode":"LLM_REQUEST_FAILED"');
    expect(user).toContain('Error: SESSION_SECRET must be set');
    expect(user).toContain('server.mjs\n… and 4 more');
    expect(user).toContain('<file path="README.md">\n## Setup\nSet SESSION_SECRET.\n</file>');
    for (const fact of ['SESSION_SECRET', 'server.mjs', 'SETUP_BUILD_FAILED']) {
      expect(request.system).not.toContain(fact);
    }
  });

  it('says when the recipe is only a fallback guess', () => {
    const user =
      recipeRepairPrompt({
        ...input,
        failure: { stage: 'recipe', code: 'SETUP_UNSUPPORTED', message: 'no Next.js app found' },
      }).messages[0]?.content ?? '';

    expect(user).toContain(
      'Recipe detection failed (SETUP_UNSUPPORTED): no Next.js app found\nThe recipe below is a fallback guess.',
    );
  });

  it('converts to a structured output format', () => {
    const format = betaZodOutputFormat(RecipePatchSchema);

    expect(format.type).toBe('json_schema');
    expect(format.schema).toMatchObject({ type: 'object' });
  });
});
