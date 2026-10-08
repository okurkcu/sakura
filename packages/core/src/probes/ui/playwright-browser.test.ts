import { describe, expect, it } from 'vitest';

import { BROWSER_INSTALL_COMMAND, launchFailureMessage } from './playwright-browser.js';

describe('launchFailureMessage', () => {
  it.each([
    [
      "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chrome",
      `Chromium for Playwright is not installed; run \`${BROWSER_INSTALL_COMMAND}\``,
    ],
    [
      'browserType.launch: Target page, context or browser has been closed\n' +
        '[err] FATAL:zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+',
      'Chromium could not start its sandbox; on Ubuntu 23.10+ allow unprivileged user namespaces (see "Chromium sandbox on Linux" in docs/cli.md)',
    ],
    ['browserType.launch: Timeout 60000ms exceeded', 'Could not start Chromium'],
  ])('explains %j', (error, message) => {
    expect(launchFailureMessage(error)).toBe(message);
  });
});
