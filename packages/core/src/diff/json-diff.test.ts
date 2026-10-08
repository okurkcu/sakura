import { describe, expect, it } from 'vitest';

import { diffJson } from './json-diff.js';
import type { JsonChange } from './json-diff.js';
import type { JsonValue } from '../domain/json.js';

describe('diffJson', () => {
  const order = {
    id: 1001,
    placedAt: '2026-01-02T10:00:00Z',
    total: 42,
    items: [{ sku: 'mug', qty: 2 }],
  };

  it('finds the api-breaking change: total turned into a string, currency added', () => {
    const head = { ...order, total: '$42.00', currency: 'USD' };

    expect(diffJson(order, order, head)).toEqual({
      changes: [
        { kind: 'field-added', path: '$.currency', after: 'USD' },
        { kind: 'type-changed', path: '$.total', before: 42, after: '$42.00' },
      ],
      raw: 2,
      noise: 0,
    });
  });

  it.each<[string, JsonValue, JsonChange[]]>([
    [
      'a removed field',
      { id: 1001, placedAt: order.placedAt, items: order.items },
      [{ kind: 'field-removed', path: '$.total', before: 42 }],
    ],
    [
      'a changed value',
      { ...order, total: 43 },
      [{ kind: 'value-changed', path: '$.total', before: 42, after: 43 }],
    ],
    [
      'a changed array element',
      { ...order, items: [{ sku: 'mug', qty: 3 }] },
      [{ kind: 'value-changed', path: '$.items[0].qty', before: 2, after: 3 }],
    ],
    [
      'an added array element',
      { ...order, items: [...order.items, { sku: 'cap', qty: 1 }] },
      [{ kind: 'field-added', path: '$.items[1]', after: { sku: 'cap', qty: 1 } }],
    ],
    [
      'an added object, as one change',
      { ...order, shipping: { carrier: 'UPS', days: 2 } },
      [{ kind: 'field-added', path: '$.shipping', after: { carrier: 'UPS', days: 2 } }],
    ],
    [
      'a changed root',
      [order],
      [{ kind: 'type-changed', path: '$', before: order, after: [order] }],
    ],
  ])('reports %s at its top-most path', (_name, head, changes) => {
    expect(diffJson(order, order, head).changes).toEqual(changes);
  });

  it('sets aside paths that differ between baseA and baseB', () => {
    const a = {
      ...order,
      servedAt: '2026-10-08T10:00:00.000Z',
      requestId: '0b6c9a3e-7d1f-4f43-9a51-0c3f2a1b9d10',
    };
    const b = {
      ...order,
      servedAt: '2026-10-08T10:00:01.000Z',
      requestId: '5f0e4c7a-2b9d-4e11-8c3a-6d7e8f9a0b1c',
    };
    const head = {
      ...order,
      servedAt: '2026-10-08T10:00:02.000Z',
      requestId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    };

    expect(diffJson(a, b, head)).toEqual({ changes: [], raw: 2, noise: 2 });
  });

  it('still reports a noisy path whose value changes shape', () => {
    const a = { servedAt: '2026-10-08T10:00:00.000Z' };
    const b = { servedAt: '2026-10-08T10:00:01.000Z' };

    expect(diffJson(a, b, { servedAt: 1791453600000 }).changes).toEqual([
      {
        kind: 'type-changed',
        path: '$.servedAt',
        before: '2026-10-08T10:00:00.000Z',
        after: 1791453600000,
      },
    ]);
    expect(diffJson(a, b, { servedAt: 'yesterday' }).changes).toEqual([
      {
        kind: 'type-changed',
        path: '$.servedAt',
        before: '2026-10-08T10:00:00.000Z',
        after: 'yesterday',
      },
    ]);
  });

  it('reports removing a whole object that holds a noisy field', () => {
    const a = { meta: { at: '2026-10-08T10:00:00Z' }, ok: true };
    const b = { meta: { at: '2026-10-08T10:00:01Z' }, ok: true };

    expect(diffJson(a, b, { ok: true }).changes).toEqual([
      { kind: 'field-removed', path: '$.meta', before: { at: '2026-10-08T10:00:00Z' } },
    ]);
  });

  it('quotes keys that are not identifiers and sorts keys', () => {
    expect(
      diffJson({ 'b-key': 1, a: 1 }, { 'b-key': 1, a: 1 }, { 'b-key': 2, a: 2 }).changes.map(
        (c) => c.path,
      ),
    ).toEqual(['$.a', '$["b-key"]']);
  });
});
