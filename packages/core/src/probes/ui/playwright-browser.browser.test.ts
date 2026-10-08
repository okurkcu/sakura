import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UiBrowser } from './browser.js';
import { CAPTURE_TIME, createPlaywrightLauncher } from './playwright-browser.js';

/** Test pages, served by the test itself: no repository code is involved. */
const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>Home</title>
    <style>
      .spin { width: 40px; height: 40px; background: #c00; animation: spin 1s linear infinite; }
      .fade { transition: opacity 3s; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <h1>Home</h1><div class="spin"></div>
    <input id="field" autofocus value="caret here">
    <p class="fade" id="later">waiting</p>
    <script>
      setTimeout(() => { document.getElementById('later').style.opacity = '0.3'; }, 50);
    </script>`,
  '/errors': `<!doctype html><title>Errors</title><h1>Errors</h1>
    <img src="https://images.example.com/logo.png">
    <script>
      console.error('widget failed to load');
      console.warn('only a warning');
      fetch('/api/missing');
      fetch('http://127.0.0.1:9/other-service').catch(() => {});
      new WebSocket('ws://127.0.0.1:9/socket');
      setTimeout(() => { throw new TypeError('late failure'); }, 0);
    </script>`,
  '/time': `<!doctype html><title>Time</title><p id="now"></p>
    <script>document.getElementById('now').textContent = new Date().toISOString();</script>`,
  '/dates': `<!doctype html><title>Dates</title><p id="out"></p>
    <script>
      class Stamp extends Date {}
      const later = new Date(Date.UTC(2030, 5, 1));
      document.getElementById('out').textContent = [
        typeof Date(),
        new Date(0).toISOString(),
        later.getUTCFullYear(),
        new Date() instanceof Date,
        new Stamp() instanceof Stamp,
        new Stamp().getTime() >= ${String(CAPTURE_TIME)},
        new Date().constructor === Date,
      ].join('|');
    </script>`,
  '/unread': `<!doctype html><title>Unread</title><h1>Unread body</h1>
    <script>fetch('/api/stream').then((response) => console.log(response.status));</script>`,
  '/poll': `<!doctype html><title>Poll</title><h1>Polling</h1>
    <script>setInterval(() => fetch('/api/ping'), 100);</script>`,
};

describe('createPlaywrightLauncher (real Chromium)', () => {
  let server: Server;
  let origin: string;
  let dir: string;
  let browser: UiBrowser | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bdiff-browser-'));
    server = createServer((request, response) => {
      const url = request.url ?? '/';
      if (url === '/slow') {
        return; // never answers
      }
      if (url === '/api/stream') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('the body never ends');
        return;
      }
      if (url === '/api/ping') {
        response.end('pong');
        return;
      }
      const page = PAGES[url];
      response.statusCode = page === undefined ? 404 : 200;
      response.setHeader('content-type', 'text/html');
      response.end(page ?? '<!doctype html><title>Not found</title><h1>404</h1>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    browser = await createPlaywrightLauncher({ settleMs: 100 }).launch(
      new AbortController().signal,
    );
  });

  afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const capture = (route: string, name: string, timeoutMs = 15_000) => {
    if (browser === undefined) {
      throw new Error('the browser did not start');
    }
    return browser.capture(`${origin}${route}`, {
      screenshotPath: path.join(dir, `${name}.png`),
      timeoutMs,
    });
  };

  it('captures the same page twice into identical screenshots, animations and caret included', async () => {
    const first = await capture('/', 'home-a');
    const second = await capture('/', 'home-b');

    expect(first).toMatchObject({
      status: 200,
      title: 'Home',
      screenshotSaved: true,
      settled: true,
    });
    expect(first.text).toContain('Home');
    expect(second.text).toBe(first.text);
    expect(
      Buffer.compare(
        await readFile(path.join(dir, 'home-a.png')),
        await readFile(path.join(dir, 'home-b.png')),
      ),
    ).toBe(0);
  });

  it('records console errors, page errors, failed requests, and blocks other origins', async () => {
    const seen = await capture('/errors', 'errors');

    expect(seen.consoleErrors).toEqual(expect.arrayContaining(['widget failed to load']));
    expect(seen.consoleErrors.join('\n')).not.toContain('only a warning');
    expect(seen.pageErrors).toEqual(['TypeError: late failure']);
    expect(seen.failedRequests).toEqual([
      { url: `${origin}/api/missing`, method: 'GET', status: 404 },
    ]);
    expect(seen.blockedRequests).toEqual([
      'http://127.0.0.1:9/other-service',
      'https://images.example.com/logo.png',
      'ws://127.0.0.1:9/socket',
    ]);
    expect(seen.error).toBeUndefined();
  });

  it('starts every page at the fixed capture time', async () => {
    const seen = await capture('/time', 'time');

    expect(seen.text).toMatch(new RegExp(`^${new Date(CAPTURE_TIME).toISOString().slice(0, 16)}`));
  });

  it('fakes Date without breaking its API', async () => {
    const seen = await capture('/dates', 'dates');

    expect(seen.text).toBe('string|1970-01-01T00:00:00.000Z|2030|true|true|true|true');
  });

  it('records the status of a missing page without counting it as a failed request', async () => {
    const seen = await capture('/nope', 'nope');

    expect(seen).toMatchObject({ status: 404, title: 'Not found', failedRequests: [] });
  });

  it('captures a page whose network never goes idle, marked unsettled', async () => {
    const seen = await capture('/poll', 'poll', 3_000);

    expect(seen).toMatchObject({ settled: false, screenshotSaved: true, title: 'Poll' });
    expect(seen.error).toBeUndefined();
  });

  it('counts the network as quiet once every request got its response, even with a body still open', async () => {
    const seen = await capture('/unread', 'unread', 5_000);

    expect(seen).toMatchObject({ settled: true, screenshotSaved: true, title: 'Unread' });
  });

  it('turns a page that never answers into a timeout and keeps the browser usable', async () => {
    const slow = await capture('/slow', 'slow', 1_000);
    const next = await capture('/time', 'after-slow');

    expect(slow).toMatchObject({
      status: null,
      screenshotSaved: false,
      error: { code: 'PROBE_TIMEOUT' },
    });
    expect(next).toMatchObject({ status: 200, screenshotSaved: true });
  });

  it('stops a capture with ABORTED when the run is aborted, closing the browser', async () => {
    const controller = new AbortController();
    const own = await createPlaywrightLauncher().launch(controller.signal);
    const pending = own.capture(`${origin}/slow`, {
      screenshotPath: path.join(dir, 'aborted.png'),
      timeoutMs: 30_000,
    });
    setTimeout(() => {
      controller.abort();
    }, 300);

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await own.close();
  });
});
