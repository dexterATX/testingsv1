/**
 * A typed, dependency-free client for the Exa API.
 *
 * Reference: https://exa.ai/docs/reference/search-api-guide-for-coding-agents
 */

import { HttpTransport, type RequestOverrides } from '../http/transport.js';
import { ExaError, ExaRequestValidationError, exaErrorAdapter } from './errors.js';
import { parseSearchStream } from './stream.js';
import { assertValidContentsRequest, assertValidSearchRequest } from './validate.js';
import type {
  AnswerOptions,
  AnswerResponse,
  ContentsRequestOptions,
  ContentsResponse,
  SearchOptions,
  SearchRequest,
  SearchResponse,
  SearchType,
  StreamChunk,
} from './types.js';

export type { RequestOverrides };

const DEFAULT_BASE_URL = 'https://api.exa.ai';

/**
 * Per-type request timeouts. The documented latencies are base figures —
 * synthesis via `outputSchema` and forced livecrawls stack on top — so these
 * leave substantial headroom above the published numbers.
 */
const DEFAULT_TIMEOUT_MS: Record<SearchType, number> = {
  instant: 15_000,
  fast: 15_000,
  auto: 30_000,
  'deep-lite': 60_000,
  deep: 120_000,
  'deep-reasoning': 240_000,
};

const FALLBACK_TIMEOUT_MS = 30_000;

export interface ExaClientOptions {
  /** Defaults to `process.env.EXA_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.EXA_BASE_URL` or `https://api.exa.ai`. */
  baseUrl?: string;
  /**
   * Overrides the per-search-type default timeout. Set this only if you have a
   * reason to — the defaults already account for deep-search latency.
   */
  timeoutMs?: number;
  /** Retries on 429 and 5xx responses and network errors. Defaults to 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Defaults to 500. */
  retryBaseMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests, so backoff does not make suites slow. */
  sleep?: (ms: number) => Promise<void>;
}

export class ExaClient {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number | undefined;

  constructor(options: ExaClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env['EXA_API_KEY'];

    if (!apiKey) {
      throw new ExaRequestValidationError(
        'Missing Exa API key. Set EXA_API_KEY in the environment (see .env.example) ' +
          'or pass `new ExaClient({ apiKey })`. Get a key at https://dashboard.exa.ai.',
      );
    }

    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') {
      throw new ExaError('No global fetch available. Use Node 18+ or pass `fetch` explicitly.');
    }

    this.timeoutMs = options.timeoutMs;
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl ?? process.env['EXA_BASE_URL'] ?? DEFAULT_BASE_URL,
      authHeaders: { 'x-api-key': apiKey },
      errors: exaErrorAdapter,
      defaultTimeoutMs: options.timeoutMs ?? FALLBACK_TIMEOUT_MS,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });
  }

  /**
   * `POST /search` — find results, optionally with content and a synthesized,
   * grounded `output`.
   *
   * `T` types `response.output.content` when you pass an `outputSchema`.
   *
   * @example
   * const res = await exa.search('best open source vector databases', {
   *   type: 'auto',
   *   numResults: 10,
   *   contents: { highlights: true },
   * });
   */
  async search<T = unknown>(
    query: string,
    options: SearchOptions & RequestOverrides = {},
  ): Promise<SearchResponse<T>> {
    const { signal, timeoutMs, ...searchOptions } = options;
    const request: SearchRequest = { query, ...searchOptions };

    assertValidSearchRequest(request);

    return this.transport.request<SearchResponse<T>>({
      path: '/search',
      body: request,
      ...(signal !== undefined ? { signal } : {}),
      timeoutMs: timeoutMs ?? this.timeoutForType(request.type),
    });
  }

  /**
   * `POST /search` with `stream: true` — yields OpenAI-compatible chunks as
   * they arrive.
   *
   * @example
   * for await (const text of streamText(exa.searchStream('...'))) {
   *   process.stdout.write(text);
   * }
   */
  async *searchStream(
    query: string,
    options: SearchOptions & RequestOverrides = {},
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const { signal, timeoutMs, ...searchOptions } = options;
    const request: SearchRequest = { query, ...searchOptions };

    assertValidSearchRequest(request);

    const response = await this.transport.request<Response>({
      path: '/search',
      body: { ...request, stream: true },
      ...(signal !== undefined ? { signal } : {}),
      timeoutMs: timeoutMs ?? this.timeoutForType(request.type),
      stream: true,
    });

    yield* parseSearchStream(response.body);
  }

  /**
   * `POST /contents` — extract content for URLs you already have.
   *
   * Note that `text`, `highlights`, and `summary` are top-level here, unlike
   * `/search`, where they nest under `contents`.
   *
   * Check `response.statuses` for per-URL failures; a URL that could not be
   * crawled is reported there rather than throwing.
   */
  async contents(
    urls: string[],
    options: ContentsRequestOptions & RequestOverrides = {},
  ): Promise<ContentsResponse> {
    const { signal, timeoutMs, ...contentsOptions } = options;

    assertValidContentsRequest(urls, contentsOptions);

    return this.transport.request<ContentsResponse>({
      path: '/contents',
      body: { urls, ...contentsOptions },
      ...(signal !== undefined ? { signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /**
   * `POST /answer` — a grounded answer with citations, for question-first UIs.
   *
   * Prefer `search()` with an `outputSchema` when you also want to inspect the
   * raw results.
   */
  async answer<T = string>(
    query: string,
    options: AnswerOptions & RequestOverrides = {},
  ): Promise<AnswerResponse<T>> {
    const { signal, timeoutMs, ...answerOptions } = options;

    if (typeof query !== 'string' || query.trim() === '') {
      throw new ExaRequestValidationError('`query` is required and must be a non-empty string.');
    }

    return this.transport.request<AnswerResponse<T>>({
      path: '/answer',
      body: { query, ...answerOptions },
      ...(signal !== undefined ? { signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  private timeoutForType(type: SearchType | undefined): number {
    if (this.timeoutMs !== undefined) return this.timeoutMs;
    if (type === undefined) return DEFAULT_TIMEOUT_MS.auto;
    return DEFAULT_TIMEOUT_MS[type] ?? FALLBACK_TIMEOUT_MS;
  }
}
