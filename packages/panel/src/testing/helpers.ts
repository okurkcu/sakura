import { request } from 'node:http';

import type { RunEvent, RunRecord, RunResult } from '@bdiff/core';
import { createTestRunRecorder, TEST_TARGET } from '@bdiff/core/testing';

/** A finished run record for panel tests. */
export function testRecord(
  runId: string,
  overrides: {
    startedAt?: string;
    headRef?: string;
    status?: 'success' | 'skipped';
    prTitle?: string;
  } = {},
): RunRecord {
  const { recorder } = createTestRunRecorder({
    target: {
      ...TEST_TARGET,
      baseRef: 'main',
      headRef: overrides.headRef ?? TEST_TARGET.headRef,
      ...(overrides.prTitle === undefined ? {} : { prTitle: overrides.prTitle }),
    },
  });
  const record = recorder.finish(
    overrides.status === 'skipped'
      ? { status: 'skipped', reason: 'docs-only' }
      : { status: 'success' },
  );
  return {
    ...record,
    runId,
    ...(overrides.startedAt === undefined ? {} : { startedAt: overrides.startedAt }),
  };
}

/** A result around `record` with the given findings and captures. */
export function testResult(
  record: RunRecord,
  extra: Partial<Omit<RunResult, 'record'>> = {},
): RunResult {
  return { record, ...extra };
}

/** `events.jsonl` text of `events`. */
export function eventLines(events: readonly RunEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

/** A raw GET that keeps `path` exactly as written (no URL normalization), for traversal tests. */
export function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { Host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
