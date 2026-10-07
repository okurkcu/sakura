import { CORE_PACKAGE_NAME } from '@bdiff/core';
import { REPORT_PACKAGE_NAME } from '@bdiff/report';
import { describe, expect, it } from 'vitest';

import { CLI_PACKAGE_NAME } from './index.js';

describe('@bdiff/cli', () => {
  it('resolves its own entry point and its workspace dependencies on core and report', () => {
    expect(CLI_PACKAGE_NAME).toBe('@bdiff/cli');
    expect(CORE_PACKAGE_NAME).toBe('@bdiff/core');
    expect(REPORT_PACKAGE_NAME).toBe('@bdiff/report');
  });
});
