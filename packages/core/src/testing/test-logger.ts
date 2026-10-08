import type { LogFields, Logger, LogLevel } from '../adapters/logger.js';

/** One captured log line: bindings of all parent loggers merged with the call's fields. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A {@link Logger} that records lines in memory instead of writing them. */
export interface TestLogger extends Logger {
  /** Every line logged through this logger or any of its children, in order. */
  readonly entries: readonly LogEntry[];
}

/** Creates a {@link TestLogger} for asserting on log output. */
export function createTestLogger(): TestLogger {
  const entries: LogEntry[] = [];
  const build = (bindings: LogFields): Logger => {
    const log =
      (level: LogLevel) =>
      (message: string, fields: LogFields = {}) => {
        entries.push({ level, message, fields: { ...bindings, ...fields } });
      };
    return {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (childBindings) => build({ ...bindings, ...childBindings }),
    };
  };
  return { ...build({}), entries };
}
