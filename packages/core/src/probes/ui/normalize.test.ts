import { describe, expect, it } from 'vitest';

import { appRelativeUrl, errorSummary, normalizeVisibleText, stripOrigin } from './normalize.js';

const ORIGIN = 'http://127.0.0.1:55012';

describe('normalizeVisibleText', () => {
  it.each([
    ['plain', 'plain'],
    ['  padded line  ', 'padded line'],
    ['a \t  b', 'a b'],
    ['a\r\nb\rc', 'a\nb\nc'],
    ['non breaking spaces　here', 'non breaking spaces here'],
    ['zero​width﻿', 'zerowidth'],
    ['\n\n  title\n\n\n\nbody  \n\n', 'title\n\nbody'],
    ['a\n \t \nb', 'a\n\nb'],
    ['', ''],
    [' \n\t\n ', ''],
  ])('normalizes %j to %j', (raw, normalized) => {
    expect(normalizeVisibleText(raw)).toBe(normalized);
  });
});

describe('stripOrigin', () => {
  it.each([
    [`Failed to load ${ORIGIN}/api/x`, 'Failed to load /api/x'],
    [`at ${ORIGIN}/_next/static/chunks/app.js:1:200`, 'at /_next/static/chunks/app.js:1:200'],
    ['ws://127.0.0.1:55012/socket closed', 'ws://<app>/socket closed'],
    ['http://127.0.0.1:3000/x is another app', 'http://127.0.0.1:3000/x is another app'],
    ['nothing to strip', 'nothing to strip'],
  ])('turns %j into %j', (text, stripped) => {
    expect(stripOrigin(text, ORIGIN)).toBe(stripped);
  });
});

describe('appRelativeUrl', () => {
  it.each([
    [`${ORIGIN}/api/orders?page=2#top`, '/api/orders?page=2#top'],
    [`${ORIGIN}/`, '/'],
    ['https://fonts.example.com/a.woff2', 'https://fonts.example.com/a.woff2'],
    ['http://127.0.0.1:3000/x', 'http://127.0.0.1:3000/x'],
    ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['not a url', 'not a url'],
  ])('records %j as %j', (url, recorded) => {
    expect(appRelativeUrl(url, ORIGIN)).toBe(recorded);
  });
});

describe('errorSummary', () => {
  it('keeps the first line without the origin', () => {
    expect(
      errorSummary(
        `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${ORIGIN}/slow"`,
        ORIGIN,
      ),
    ).toBe('page.goto: Timeout 30000ms exceeded.');
    expect(errorSummary(`net::ERR_CONNECTION_REFUSED at ${ORIGIN}/x`, ORIGIN)).toBe(
      'net::ERR_CONNECTION_REFUSED at /x',
    );
  });
});
