import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { csvField, RESULTS_CSV_COLUMNS, resultsCsvHeader, toResultsCsvRow } from './results-csv.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { createTestRunRecorder } from '../testing/run-records.js';

const docsPath = path.resolve(import.meta.dirname, '../../../../docs/metrics.md');

/** Parses one CSV line into fields (enough for rows we produce: quoted fields, doubled quotes). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (quoted) {
      if (char === '"' && line.charAt(index + 1) === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function rowAsObject(row: string): Record<string, string> {
  const values = parseCsvLine(row.replace(/\n$/, ''));
  expect(values).toHaveLength(RESULTS_CSV_COLUMNS.length);
  return Object.fromEntries(RESULTS_CSV_COLUMNS.map((name, index) => [name, values[index] ?? '']));
}

describe('RESULTS_CSV_COLUMNS', () => {
  it('is pinned: changing columns is a deliberate, documented contract change', () => {
    expect(RESULTS_CSV_COLUMNS).toEqual([
      'run_id',
      'schema_version',
      'tool_version',
      'started_at',
      'finished_at',
      'duration_ms',
      'status',
      'failure_code',
      'failure_stage',
      'failure_message',
      'skip_reason',
      'repo_url',
      'base_ref',
      'head_ref',
      'pr_number',
      'ms_workspace',
      'ms_recipe',
      'ms_environment',
      'ms_repair',
      'ms_impact',
      'ms_probe_ui',
      'ms_probe_api',
      'ms_diff',
      'ms_interpret',
      'ms_report',
      'ms_metrics',
      'setup_attempts',
      'compute_seconds_base',
      'compute_seconds_head',
      'llm_calls',
      'llm_input_tokens',
      'llm_output_tokens',
      'llm_cache_read_tokens',
      'llm_cache_write_5m_tokens',
      'llm_cache_write_1h_tokens',
      'llm_cost_usd',
      'routes_probed',
      'endpoints_probed',
      'raw_diffs',
      'noise_diffs',
      'findings',
    ]);
  });

  it('matches the column table in docs/metrics.md, in order', async () => {
    const docs = await readFile(docsPath, 'utf8');
    const section = docs.split('## `results.csv` columns')[1]?.split('\n## ')[0] ?? '';
    const documented = [...section.matchAll(/^\| `([a-z0-9_]+)` +\|/gm)].map((match) => match[1]);

    expect(documented).toEqual(RESULTS_CSV_COLUMNS);
  });

  it('starts the file with a header line', () => {
    expect(resultsCsvHeader()).toBe(`${RESULTS_CSV_COLUMNS.join(',')}\n`);
  });
});

describe('toResultsCsvRow', () => {
  it('writes a success row, leaving stages that never ran empty', async () => {
    const { recorder, clock } = createTestRunRecorder();
    await recorder.timer
      .measure('environment', () => {
        clock.advance(100);
        return Promise.reject(new Error('build failed'));
      })
      .catch(() => undefined);
    await recorder.timer.measure('environment', () => {
      clock.advance(250);
      return Promise.resolve();
    });
    recorder.recordLlmUsage('repair', {
      model: 'test-model',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
    recorder.addCounts({ findings: 3 });

    const row = rowAsObject(toResultsCsvRow(recorder.finish({ status: 'success' })));

    expect(row).toMatchObject({
      status: 'success',
      failure_code: '',
      skip_reason: '',
      repo_url: 'https://github.com/acme/shop.git',
      pr_number: '42',
      ms_environment: '350',
      ms_workspace: '',
      llm_calls: '1',
      llm_input_tokens: '1000',
      llm_cost_usd: '0.002',
      findings: '3',
    });
  });

  it('writes failure details of a failed run, quoting unsafe text', async () => {
    const { recorder } = createTestRunRecorder();
    const error = await recorder.timer
      .measure('recipe', () =>
        Promise.reject(
          new BdiffError('SETUP_MISSING_ENV', 'missing "DATABASE_URL", REDIS_URL\nsee README'),
        ),
      )
      .catch((caught: unknown) => caught);

    const line = toResultsCsvRow(recorder.finish({ status: 'failed', error }));
    const row = rowAsObject(line);

    expect(row).toMatchObject({
      status: 'failed',
      failure_code: 'SETUP_MISSING_ENV',
      failure_stage: 'recipe',
      failure_message: 'missing "DATABASE_URL", REDIS_URL\nsee README',
    });
  });

  it('writes the skip reason of a skipped run', () => {
    const { recorder } = createTestRunRecorder();

    const row = rowAsObject(
      toResultsCsvRow(recorder.finish({ status: 'skipped', reason: 'docs-only' })),
    );

    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'docs-only' });
  });
});

describe('csvField', () => {
  it.each([
    [undefined, ''],
    [0, '0'],
    [1.5, '1.5'],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['cr\r', '"cr\r"'],
  ])('encodes %j as %j', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
});
