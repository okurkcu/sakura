import { describe, expect, it } from 'vitest';

import { escapeHtml, html, raw } from './html.js';

// Prettier reformats `html` templates as HTML; these tests compare exact strings, so they opt out.
describe('html', () => {
  it('escapes every interpolated string, in content and attributes', () => {
    const title = '<script>alert("x")</script>';
    const attribute = '" onmouseover="alert(1)';

    // prettier-ignore
    expect(html`<p title="${attribute}">${title}</p>`.toString()).toBe(
      '<p title="&quot; onmouseover=&quot;alert(1)">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>',
    );
  });

  it('keeps safe fragments and joins lists', () => {
    // prettier-ignore
    const items = ['a&b', 'c'].map((item) => html`<li>${item}</li>`);

    // prettier-ignore
    expect(html`<ul>${items}</ul>`.toString()).toBe('<ul><li>a&amp;b</li><li>c</li></ul>');
    // prettier-ignore
    expect(html`<style>${raw('a > b {}')}</style>`.toString()).toBe('<style>a > b {}</style>');
  });

  it('renders nothing for null, undefined and false, and numbers as text', () => {
    // prettier-ignore
    expect(html`${null}${undefined}${false}${0}${true}`.toString()).toBe('0true');
  });

  it.each([
    ["'", '&#39;'],
    ['&amp;', '&amp;amp;'],
  ])('escapes %j as %j', (text, escaped) => {
    expect(escapeHtml(text)).toBe(escaped);
  });
});
