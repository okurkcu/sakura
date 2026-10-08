import { describe, expect, it } from 'vitest';

import { pagesApiMethods } from './handler-methods.js';

describe('pagesApiMethods', () => {
  it.each([
    ["if (req.method === 'POST') { create(); } else { list(); }", ['POST']],
    [
      'switch (req.method) { case "PUT": update(); break; case `DELETE`: remove(); }',
      ['PUT', 'DELETE'],
    ],
    [
      "if (!['GET', 'PATCH'].includes(req.method ?? '')) return res.status(405).end();",
      ['GET', 'PATCH'],
    ],
    ["const { method } = req; if (method !== 'POST') return;", ['POST']],
    ["res.json({ verb: 'POST' }); // never reads the method", []],
    ['export default function handler(req, res) { res.json({ ok: true }); }', []],
  ])('finds the methods checked in %j', (source, methods) => {
    expect(pagesApiMethods(source)).toEqual(methods);
  });
});
