import { pino } from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';

import { SECRET_ENV_VARS } from './secrets.js';

/** Log levels bdiff uses. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured context attached to a log line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Structured logger. Core code logs through this interface only, never `console`. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every line, e.g. `logger.child({ stage: 'recipe' })`. */
  child(bindings: LogFields): Logger;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  readonly level: LogLevel;
  /** Where JSON lines go. Defaults to stderr, keeping stdout free for command output. */
  readonly destination?: DestinationStream;
}

const SENSITIVE_KEYS = [
  ...SECRET_ENV_VARS,
  'apiKey',
  'token',
  'password',
  'secret',
  'authorization',
  'Authorization',
];

/** Values under these keys are replaced, at the top level and up to two levels deep. */
const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

/** Creates the real pino-backed logger: JSON lines, ISO timestamps, secrets redacted. */
export function createLogger(options: LoggerOptions): Logger {
  const instance = pino(
    {
      level: options.level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    options.destination ?? pino.destination(2),
  );
  return wrap(instance);
}

function wrap(instance: PinoLogger): Logger {
  return {
    debug: (message, fields) => {
      instance.debug(fields ?? {}, message);
    },
    info: (message, fields) => {
      instance.info(fields ?? {}, message);
    },
    warn: (message, fields) => {
      instance.warn(fields ?? {}, message);
    },
    error: (message, fields) => {
      instance.error(fields ?? {}, message);
    },
    child: (bindings) => wrap(instance.child(bindings)),
  };
}
