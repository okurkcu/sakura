import { CORE_PACKAGE_NAME } from '@bdiff/core';
import { describe, expect, it } from 'vitest';

import { REPORT_PACKAGE_NAME } from './index.js';

describe('@bdiff/report', () => {
  it('resolves its own entry point and its workspace dependency on core', () => {
    expect(REPORT_PACKAGE_NAME).toBe('@bdiff/report');
    expect(CORE_PACKAGE_NAME).toBe('@bdiff/core');
  });
});
