import type { HttpClient, HttpRequestOptions, HttpResponse } from '../adapters/http.js';
import { throwIfAborted } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** What a scripted URL answers: a status, or no response at all (connection refused). */
export type FakeHttpAnswer = number | 'refused';

/**
 * Scripted {@link HttpClient}. Each URL answers from its queue of answers, repeating the last one;
 * an unscripted URL is refused. Every request is recorded in {@link FakeHttp.requests}.
 */
export class FakeHttp implements HttpClient {
  readonly requests: string[] = [];
  readonly #answers = new Map<string, FakeHttpAnswer[]>();

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
}
