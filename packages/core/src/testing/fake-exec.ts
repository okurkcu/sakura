import { execTimeoutError } from '../adapters/exec.js';
import type { Exec, ExecOptions, ExecResult } from '../adapters/exec.js';
import { throwIfAborted } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** One recorded call to {@link FakeExec.run}. */
export interface ExecCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

/** Selects calls by command and, optionally, exact arguments; or any predicate. */
export type ExecCallMatcher =
  { readonly cmd: string; readonly args?: readonly string[] } | ((call: ExecCall) => boolean);

/** What a matched call does: return a result, throw an error, time out, or compute a result. */
export type FakeExecResponse =
  | Partial<ExecResult>
  | { readonly error: Error }
  | { readonly timeout: true }
  | ((call: ExecCall) => ExecResult | Promise<ExecResult>);

interface Rule {
  readonly matches: (call: ExecCall) => boolean;
  readonly response: FakeExecResponse;
}

/**
 * Scripted {@link Exec} for tests. Register responses with {@link FakeExec.on}; the first matching
 * rule wins. A call with no matching rule throws, so tests never pass by accident. Every call is
 * recorded in {@link FakeExec.calls}.
 */
export class FakeExec implements Exec {
  readonly calls: ExecCall[] = [];
  readonly #rules: Rule[] = [];

  /** Registers `response` for calls selected by `matcher`. Returns `this` for chaining. */
  on(matcher: ExecCallMatcher, response: FakeExecResponse): this {
    this.#rules.push({ matches: toPredicate(matcher), response });
    return this;
  }

  async run(cmd: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    throwIfAborted(options.signal);
    const call: ExecCall = { cmd, args: [...args], options };
    this.calls.push(call);

    const rule = this.#rules.find((candidate) => candidate.matches(call));
    if (rule === undefined) {
      throw new BdiffError(
        'INTERNAL',
        `FakeExec: no response registered for: ${cmd} ${args.join(' ')}`,
      );
    }
    const { response } = rule;
    if (typeof response === 'function') {
      return response(call);
    }
    if ('error' in response) {
      throw response.error;
    }
    if ('timeout' in response) {
      throw execTimeoutError(cmd, args, options.timeoutMs);
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, ...response };
  }
}

function toPredicate(matcher: ExecCallMatcher): (call: ExecCall) => boolean {
  if (typeof matcher === 'function') {
    return matcher;
  }
  const { cmd, args } = matcher;
  return (call) =>
    call.cmd === cmd &&
    (args === undefined ||
      (args.length === call.args.length && args.every((arg, index) => arg === call.args[index])));
}
