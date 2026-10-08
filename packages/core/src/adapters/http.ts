import { abortError } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Options of one HTTP request. Timeout and abort signal are mandatory, like for `Exec`. */
export interface HttpRequestOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Outcome of a request that got a response, whatever its status. */
export interface HttpResponse {
  readonly status: number;
}

/** Makes HTTP requests. Only ever pointed at bdiff's own containers. */
export interface HttpClient {
  /**
   * Sends a GET and returns the status; the body is discarded.
   *
   * @throws BdiffError `HTTP_FAILED` when there is no response (connection refused, timeout), or
   *   the abort error of `signal`.
   */
  get(url: string, options: HttpRequestOptions): Promise<HttpResponse>;
}

/** The real {@link HttpClient}, over `fetch`. Redirects are not followed. */
export function createFetchHttpClient(): HttpClient {
  return {
    get: async (url, options) => {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      try {
        const response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.any([options.signal, timeout]),
        });
        await response.body?.cancel();
        return { status: response.status };
      } catch (error) {
        if (options.signal.aborted) {
          throw abortError(options.signal);
        }
        throw new BdiffError('HTTP_FAILED', `GET ${url} failed`, {
          cause: error,
          details: { url, timedOut: timeout.aborted },
        });
      }
    },
  };
}
