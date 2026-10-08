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

/** One request of {@link HttpClient.request}. */
export interface HttpExchangeRequest extends HttpRequestOptions {
  readonly method: string;
  readonly url: string;
  /** Sent as given; no cookies are ever added. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Most bytes of the response body read; the rest is discarded and `truncated` set. */
  readonly maxBodyBytes: number;
}

/** A response with its headers and (possibly truncated) body. */
export interface HttpExchangeResponse {
  readonly status: number;
  /** Lower-case names; repeated headers joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly truncated: boolean;
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
  /**
   * Sends a request and reads the response, body included up to `maxBodyBytes`. The timeout covers
   * reading the body too.
   *
   * @throws BdiffError `HTTP_FAILED` when there is no complete response (`details.timedOut` tells a
   *   timeout apart), or the abort error of `signal`.
   */
  request(request: HttpExchangeRequest): Promise<HttpExchangeResponse>;
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
    request: async (request) => {
      const timeout = AbortSignal.timeout(request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: 'manual',
          credentials: 'omit',
          signal: AbortSignal.any([request.signal, timeout]),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        const { body, truncated } = await readBody(response, request.maxBodyBytes);
        return { status: response.status, headers, body, truncated };
      } catch (error) {
        if (request.signal.aborted) {
          throw abortError(request.signal);
        }
        throw new BdiffError('HTTP_FAILED', `${request.method} ${request.url} failed`, {
          cause: error,
          details: { url: request.url, method: request.method, timedOut: timeout.aborted },
        });
      }
    },
  };
}

/** Reads at most `maxBytes` of a response body, then cancels the rest. */
async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (response.body === null) {
    return { body: new Uint8Array(), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  // Node types fetch bodies as streams of `any`; they carry bytes.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}
