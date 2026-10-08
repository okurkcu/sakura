import { randomBytes as cryptoRandomBytes } from 'node:crypto';

import { z } from 'zod';

import type { Clock } from '../adapters/clock.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Crockford base32, lowercase. Lowercase so the id is valid as a docker compose project name. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;
const MAX_TIME_MS = 2 ** 48 - 1;

/** A run id: a lowercase ULID. Sorts by creation time and is safe in paths and compose names. */
export const RunIdSchema = z
  .string()
  .regex(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/, 'expected a lowercase ULID');
export type RunId = z.infer<typeof RunIdSchema>;

/**
 * Creates a new run id from the clock's current time and 80 random bits.
 *
 * @param randomBytes - Source of randomness; injectable for deterministic tests.
 */
export function createRunId(
  clock: Clock,
  randomBytes: (size: number) => Uint8Array = cryptoRandomBytes,
): RunId {
  return encodeUlid(clock.now().getTime(), randomBytes(RANDOM_BYTES));
}

/** Encodes a ULID from a millisecond timestamp and 10 random bytes. Pure. */
export function encodeUlid(timeMs: number, random: Uint8Array): RunId {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) {
    throw new BdiffError('INVALID_INPUT', `ULID time out of range: ${String(timeMs)}`);
  }
  if (random.length !== RANDOM_BYTES) {
    throw new BdiffError(
      'INVALID_INPUT',
      `ULID needs ${String(RANDOM_BYTES)} random bytes, got ${String(random.length)}`,
    );
  }

  let time = timeMs;
  let timePart = '';
  for (let index = 0; index < TIME_CHARS; index++) {
    timePart = charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }

  let bits = random.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  let randomPart = '';
  for (let index = 0; index < RANDOM_CHARS; index++) {
    randomPart = charAt(Number(bits & 31n)) + randomPart;
    bits >>= 5n;
  }
  return timePart + randomPart;
}

function charAt(index: number): string {
  const char = ALPHABET[index];
  if (char === undefined) {
    throw new BdiffError('INTERNAL', `base32 digit out of range: ${String(index)}`);
  }
  return char;
}
