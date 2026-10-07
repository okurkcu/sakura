import { describe, expect, it } from 'vitest';

import { CORE_PACKAGE_NAME } from './index.js';

describe('@bdiff/core', () => {
  it('resolves its own entry point', () => {
    expect(CORE_PACKAGE_NAME).toBe('@bdiff/core');
  });
});
