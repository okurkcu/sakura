import { describe, expect, it } from 'vitest';

import { createRunId, encodeUlid, RunIdSchema } from './run-id.js';
import { FakeClock } from '../testing/fake-clock.js';

const zeros = new Uint8Array(10);
const ones = new Uint8Array(10).fill(0xff);

describe('encodeUlid', () => {
  it('encodes the time part like the ULID spec example, in lowercase', () => {
    // Spec example: 1469918176385 ms encodes to 01ARYZ6S41.
    expect(encodeUlid(1469918176385, zeros)).toBe('01aryz6s410000000000000000');
  });

  it('encodes 80 random bits into 16 characters', () => {
    expect(encodeUlid(0, ones)).toBe('0000000000zzzzzzzzzzzzzzzz');
  });

  it('sorts lexicographically by time', () => {
    const earlier = encodeUlid(1_700_000_000_000, ones);
    const later = encodeUlid(1_700_000_000_001, zeros);

    expect(earlier < later).toBe(true);
  });

  it.each([
    { name: 'negative time', time: -1, random: zeros },
    { name: 'time beyond 48 bits', time: 2 ** 48, random: zeros },
    { name: 'fractional time', time: 1.5, random: zeros },
    { name: 'too few random bytes', time: 0, random: new Uint8Array(9) },
  ])('rejects $name', ({ time, random }) => {
    expect(() => encodeUlid(time, random)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});

describe('createRunId', () => {
  it("uses the clock's time and the injected randomness", () => {
    const clock = new FakeClock(new Date(1469918176385));

    expect(createRunId(clock, () => zeros)).toBe('01aryz6s410000000000000000');
  });

  it('produces valid, distinct ids with real randomness', () => {
    const clock = new FakeClock();
    const ids = new Set(Array.from({ length: 50 }, () => createRunId(clock)));

    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(RunIdSchema.safeParse(id).success).toBe(true);
    }
  });
});

describe('RunIdSchema', () => {
  it.each([
    { name: 'uppercase', id: '01ARYZ6S410000000000000000' },
    { name: 'too short', id: '01aryz6s41' },
    { name: 'excluded letter u', id: '01aryz6s41000000000000000u' },
    { name: 'path traversal', id: '../../../../../../../etc/x' },
    { name: 'time overflow', id: '81aryz6s410000000000000000' },
  ])('rejects $name', ({ id }) => {
    expect(RunIdSchema.safeParse(id).success).toBe(false);
  });
});
