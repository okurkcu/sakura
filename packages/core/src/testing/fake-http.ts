import type {
  HttpClient,
  HttpExchangeRequest,
  HttpExchangeResponse,
  HttpRequestOptions,
  HttpResponse,
} from '../adapters/http.js';
import { throwIfAborted } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** What a scripted URL answers: a status, or no response at all (connection refused). */
export type FakeHttpAnswer = number | 'refused';

/**
 * What a scripted {@link HttpClient.request} answers: a response (body as text or bytes, default
 * empty), no response (`refused`), or a `timeout`.
 */
export type FakeHttpExchange =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Uint8Array;
      readonly truncated?: boolean;
    }
  | 'refused'
  | 'timeout';

/**
 * Scripted {@link HttpClient}. Each URL answers from its queue of answers, repeating the last one;
 * an unscripted URL is refused. Every request is recorded: `get` URLs in {@link FakeHttp.requests},
 * full requests in {@link FakeHttp.exchanges}.
 */
export class FakeHttp implements HttpClient {
  readonly requests: string[] = [];
  readonly exchanges: HttpExchangeRequest[] = [];
  readonly #answers = new Map<string, FakeHttpAnswer[]>();
  readonly #exchanges = new Map<string, FakeHttpExchange[]>();

  /** Scripts `url` to answer with `answers` in order, then keep answering the last one. */
  on(url: string, ...answers: FakeHttpAnswer[]): this {
    this.#answers.set(url, answers);
    return this;
  }

  get(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
    throwIfAborted(options.signal);
    this.requests.push(url);
    const queue = this.#answers.get(url) ?? [];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer === undefined || answer === 'refused') {
      return Promise.reject(new BdiffError('HTTP_FAILED', `GET ${url} failed: connection refused`));
    }
    return Promise.resolve({ status: answer });
  }

  /** Scripts `METHOD url` (e.g. `POST http://app/api/x`) for {@link FakeHttp.request}. */
  onRequest(key: string, ...answers: FakeHttpExchange[]): this {
    this.#exchanges.set(key, answers);
    return this;
  }

  request(request: HttpExchangeRequest): Promise<HttpExchangeResponse> {
    throwIfAborted(request.signal);
    this.exchanges.push(request);
    const key = `${request.method} ${request.url}`;
    const queue = this.#exchanges.get(key) ?? [];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer === undefined || answer === 'refused' || answer === 'timeout') {
      const timedOut = answer === 'timeout';
      return Promise.reject(
        new BdiffError('HTTP_FAILED', `${key} failed: ${timedOut ? 'timed out' : 'refused'}`, {
          details: { url: request.url, method: request.method, timedOut },
        }),
      );
    }
    const body =
      typeof answer.body === 'string'
        ? new TextEncoder().encode(answer.body)
        : (answer.body ?? new Uint8Array());
    return Promise.resolve({
      status: answer.status,
      headers: answer.headers ?? {},
      body,
      truncated: answer.truncated ?? false,
    });
  }
}
