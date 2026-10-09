import path from 'node:path';

import type { RunEventInput } from './run-event.js';
import type { Clock } from '../adapters/clock.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { LogFields, Logger } from '../adapters/logger.js';
import { StageNameSchema } from '../domain/stage.js';

/** Appends a run's progress events to its `events.jsonl`. */
export interface RunEventLog {
  /**
   * Stamps `event` with the current time and appends it as one JSON line. Never throws and never
   * waits: writes happen in order in the background, and a failed write is logged once, never
   * failing the run.
   */
  emit(event: RunEventInput): void;
  /** Resolves once every event emitted so far was written (or failed to be). */
  flush(): Promise<void>;
}

/** Inputs of {@link createRunEventLog}. */
export interface RunEventLogOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  /** Where write failures are reported (once). Must not itself write to this log. */
  readonly logger: Logger;
  /** The `events.jsonl` file; its directory is created on the first write. */
  readonly file: string;
}

/**
 * Creates the event log of one run. Each event is appended with its own write (no buffering), so a
 * reader tailing the file sees it at once.
 */
export function createRunEventLog(options: RunEventLogOptions): RunEventLog {
  const { fs, clock, logger, file } = options;
  let pending: Promise<void> = Promise.resolve();
  let dirReady = false;
  let failed = false;
  return {
    emit: (input) => {
      const event = { ...input, at: clock.now().toISOString() };
      const line = `${JSON.stringify(event)}\n`;
      pending = pending.then(async () => {
        if (failed) {
          return;
        }
        try {
          if (!dirReady) {
            await fs.mkdir(path.dirname(file));
            dirReady = true;
          }
          await fs.appendFile(file, line);
        } catch (error) {
          // Progress events are a convenience: losing them must never fail the run.
          failed = true;
          logger.warn('run events could not be written; live progress stops', { file, err: error });
        }
      });
    },
    flush: () => pending,
  };
}

/** A {@link RunEventLog} that writes nothing. */
export const noRunEventLog: RunEventLog = {
  emit: () => undefined,
  flush: () => Promise.resolve(),
};

/**
 * A logger that also sends its info, warn and error lines to `events` as `log` events, with the
 * `stage` binding of the logger they came from. Debug lines and fields stay out of the events
 * (fields may hold details that belong in the structured log only).
 */
export function teeLoggerToEvents(
  logger: Logger,
  events: RunEventLog,
  bindings: LogFields = {},
): Logger {
  const parsedStage = StageNameSchema.safeParse(bindings.stage);
  const stage = parsedStage.success ? { stage: parsedStage.data } : {};
  const send = (level: 'info' | 'warn' | 'error', message: string) => {
    events.emit({ type: 'log', level, message, ...stage });
  };
  return {
    debug: (message, fields) => {
      logger.debug(message, fields);
    },
    info: (message, fields) => {
      logger.info(message, fields);
      send('info', message);
    },
    warn: (message, fields) => {
      logger.warn(message, fields);
      send('warn', message);
    },
    error: (message, fields) => {
      logger.error(message, fields);
      send('error', message);
    },
    child: (childBindings) =>
      teeLoggerToEvents(logger.child(childBindings), events, { ...bindings, ...childBindings }),
  };
}
