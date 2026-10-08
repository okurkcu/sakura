import { describe, expect, it } from 'vitest';

import { jsonLines, jsonView } from './json-view.js';

describe('jsonLines', () => {
  it('pretty-prints with sorted keys and tags every line with its path', () => {
    expect(
      jsonLines({ total: '$42.00', currency: 'USD', items: [{ sku: 'mug' }], 'odd-key': [] }),
    ).toEqual([
      { text: '{', path: '$' },
      { text: '  "currency": "USD",', path: '$.currency' },
      { text: '  "items": [', path: '$.items' },
      { text: '    {', path: '$.items[0]' },
      { text: '      "sku": "mug"', path: '$.items[0].sku' },
      { text: '    }', path: '$.items[0]' },
      { text: '  ],', path: '$.items' },
      { text: '  "odd-key": [],', path: '$["odd-key"]' },
      { text: '  "total": "$42.00"', path: '$.total' },
      { text: '}', path: '$' },
    ]);
  });

  it('prints a scalar root', () => {
    expect(jsonLines(42)).toEqual([{ text: '42', path: '$' }]);
  });
});

describe('jsonView', () => {
  it('highlights lines at or below the changed paths and escapes values', () => {
    const view = jsonView({ total: '<b>$42</b>', items: [{ sku: 'mug' }] }, [
      '$.total',
      '$.items[0]',
    ]).toString();

    expect(view).toContain(
      '<span class="line changed">  &quot;total&quot;: &quot;&lt;b&gt;$42&lt;/b&gt;&quot;</span>',
    );
    expect(view).toContain(
      '<span class="line changed">      &quot;sku&quot;: &quot;mug&quot;</span>',
    );
    expect(view).toContain('<span class="line">  &quot;items&quot;: [</span>');
    expect(view).not.toContain('<b>');
  });
});
