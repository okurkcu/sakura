/**
 * `pnpm candidates [--out <dir>] [--months <n>] [--max-repos <n>] [--validate]`
 *
 * Finds candidate PRs for the experiment's dataset on GitHub (needs `GITHUB_TOKEN`) and writes
 * `<out>/candidates.json` (ranked; each candidate is a dataset entry) and `<out>/candidates.md`.
 * With `--validate`, also checks that bdiff can check out each candidate and detect a recipe.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { cacheDir } from '@bdiff/cli';
import { createExecaExec, createLogger, nodeFileSystem, systemClock } from '@bdiff/core';
import { z } from 'zod';

import { createGitHubApi } from './candidates/github.js';
import { candidatesMarkdown } from './candidates/markdown.js';
import { CandidatesFileSchema } from './candidates/schema.js';
import { findCandidates } from './candidates/search.js';
import { createSetupCheck, validateCandidates } from './candidates/validate.js';

const AgentAuthorsSchema = z.object({ logins: z.array(z.string().min(1)) });
const DAY_MS = 24 * 60 * 60_000;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'datasets' },
      months: { type: 'string', default: '6' },
      'max-repos': { type: 'string', default: '60' },
      validate: { type: 'boolean', default: false },
    },
  });
  const months = Number(values.months);
  const maxRepos = Number(values['max-repos']);
  if (!Number.isInteger(months) || months < 1 || !Number.isInteger(maxRepos) || maxRepos < 1) {
    process.stderr.write('candidates: --months and --max-repos must be positive integers\n');
    return 2;
  }
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === '') {
    process.stderr.write('candidates: set GITHUB_TOKEN (e.g. GITHUB_TOKEN=$(gh auth token))\n');
    return 2;
  }

  const logger = createLogger({ level: 'info' });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  const agents = AgentAuthorsSchema.parse(
    JSON.parse(await readFile(path.join(import.meta.dirname, 'agent-authors.json'), 'utf8')),
  );
  const cache = cacheDir(process.env);
  const api = createGitHubApi({
    token,
    cacheDir: path.join(cache, 'github'),
    fs: nodeFileSystem,
    clock: systemClock,
    logger,
  });
  const now = systemClock.now();
  const since = new Date(now.getTime() - Math.round(months * 30.5) * DAY_MS);

  const found = await findCandidates(api, {
    since,
    minStars: 200,
    maxRepos,
    prsPerRepo: 25,
    candidatesPerRepo: 8,
    agentAccounts: agents.logins,
    logger,
  });
  const candidates = values.validate
    ? await validateCandidates(
        found.candidates,
        createSetupCheck({
          exec: createExecaExec(),
          fs: nodeFileSystem,
          clock: systemClock,
          logger,
          cacheDir: cache,
          workDir: path.join(cache, 'candidate-checks'),
          cwd: process.cwd(),
          signal: controller.signal,
        }),
        logger,
      )
    : found.candidates;

  const file = CandidatesFileSchema.parse({
    generatedAt: now.toISOString(),
    since: since.toISOString().slice(0, 10),
    repos: found.repos,
    candidates,
  });
  const outDir = path.resolve(values.out);
  await nodeFileSystem.mkdir(outDir);
  await nodeFileSystem.writeFile(
    path.join(outDir, 'candidates.json'),
    `${JSON.stringify(file, null, 2)}\n`,
  );
  await nodeFileSystem.writeFile(path.join(outDir, 'candidates.md'), candidatesMarkdown(file));
  process.stdout.write(
    `candidates: ${String(file.candidates.length)} PRs across ${String(file.repos)} repositories → ${path.join(outDir, 'candidates.json')}\n`,
  );
  return 0;
}

process.exitCode = await main();
