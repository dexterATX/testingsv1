/**
 * A typed, dependency-free client for the Exa API.
 *
 * Reference: https://exa.ai/docs/reference/search-api-guide-for-coding-agents
 */

import {
  ExaConnectionError,
  ExaError,
  ExaRequestValidationError,
  ExaTimeoutError,
  errorForStatus,
  isRetryable,
} from './errors.js';
import { parseSearchStream } from './stream.js';
import {
  assertValidContentsRequest,
  assertValidSearchRequest,
} from './validate.js';
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
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 20_000;

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

export interface RequestOverrides {
  /** Aborts the request. Combined with the internal timeout signal. */
  signal?: AbortSignal;
  /** Overrides the timeout for this call only. */
  timeoutMs?: number;
}

interface RequestConfig extends RequestOverrides {
  path: string;
  body: unknown;
  stream?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Combines the timeout signal with a caller-supplied one, when present. */
function combineSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);

  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (a.aborted) controller.abort(a.reason);
  else if (b.aborted) controller.abort(b.reason);
  else {
    a.addEventListener('abort', forward(a), { once: true });
    b.addEventListener('abort', forward(b), { once: true });
  }
  return controller.signal;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

function extractRequestId(body: unknown, response: Response): string | undefined {
  if (typeof body === 'object' && body !== null && 'requestId' in body) {
    const id = (body as { requestId?: unknown }).requestId;
    if (typeof id === 'string') return id;
  }
  return response.headers.get('x-request-id') ?? undefined;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim() !== '') return body.trim();

  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (typeof value === 'object' && value !== null) {
        const nested = (value as Record<string, unknown>)['message'];
        if (typeof nested === 'string' && nested.trim() !== '') return nested.trim();
      }
    }
  }

  return `Exa API request failed with status ${status}.`;
}

export class ExaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ExaClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env['EXA_API_KEY'];

    if (!apiKey) {
      throw new ExaRequestValidationError(
        'Missing Exa API key. Set EXA_API_KEY in the environment (see .env.example) ' +
          'or pass `new ExaClient({ apiKey })`. Get a key at https://dashboard.exa.ai.',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? process.env['EXA_BASE_URL'] ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;

    if (typeof this.fetchImpl !== 'function') {
      throw new ExaError('No global fetch available. Use Node 18+ or pass `fetch` explicitly.');
    }
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

    return this.request<SearchResponse<T>>({
      path: '/search',
      body: request,
      signal,
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

    const response = await this.request<Response>({
      path: '/search',
      body: { ...request, stream: true },
      signal,
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

    return this.request<ContentsResponse>({
      path: '/contents',
      body: { urls, ...contentsOptions },
      signal,
      timeoutMs,
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

    return this.request<AnswerResponse<T>>({
      path: '/answer',
      body: { query, ...answerOptions },
      signal,
      timeoutMs,
    });
  }

  private timeoutForType(type: SearchType | undefined): number {
    if (this.timeoutMs !== undefined) return this.timeoutMs;
    if (type === undefined) return DEFAULT_TIMEOUT_MS.auto;
    return DEFAULT_TIMEOUT_MS[type] ?? FALLBACK_TIMEOUT_MS;
  }

  /** Sends a request, retrying transient failures with exponential backoff. */
  private async request<T>(config: RequestConfig): Promise<T> {
    const timeoutMs = config.timeoutMs ?? this.timeoutMs ?? FALLBACK_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(config, timeoutMs);
      } catch (error) {
        lastError = error;

        if (!isRetryable(error) || attempt === this.maxRetries) throw error;

        await this.sleep(this.backoffMs(attempt, error));
      }
    }

    throw lastError;
  }

  private backoffMs(attempt: number, error: unknown): number {
    // Honor Retry-After when the API sends one; it knows better than we do.
    const retryAfter =
      error instanceof Object && 'retryAfterSeconds' in error
        ? (error as { retryAfterSeconds?: number }).retryAfterSeconds
        : undefined;

    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
    }

    const exponential = this.retryBaseMs * 2 ** attempt;
    // Full jitter, to avoid synchronized retries across concurrent callers.
    return Math.min(exponential * (0.5 + Math.random() * 0.5), MAX_RETRY_DELAY_MS);
  }

  private async attempt<T>(config: RequestConfig, timeoutMs: number): Promise<T> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = combineSignals(timeoutController.signal, config.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${config.path}`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: config.stream ? 'text/event-stream' : 'application/json',
          ...this.extraHeaders,
        },
        body: JSON.stringify(config.body),
        signal,
      });
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new ExaTimeoutError(
          `Exa request to ${config.path} timed out after ${timeoutMs} ms. ` +
            `Deep search types need a longer timeout — raise \`timeoutMs\` if this is expected.`,
          { timeoutMs, cause: error },
        );
      }
      // A caller-initiated abort is intentional; surface it unchanged.
      if (config.signal?.aborted) throw error;

      throw new ExaConnectionError(
        `Could not reach the Exa API at ${this.baseUrl}${config.path}.`,
        { cause: error },
      );
    } finally {
      // The streaming path keeps reading the body after this returns, but the
      // timeout only needs to cover establishing the response.
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await this.readBody(response);
      throw errorForStatus(response.status, {
        message: extractErrorMessage(body, response.status),
        requestId: extractRequestId(body, response),
        body,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      });
    }

    // Streaming callers consume `response.body` themselves.
    if (config.stream) return response as unknown as T;

    const body = await this.readBody(response);

    if (typeof body === 'string') {
      throw new ExaError(
        `Expected JSON from ${config.path} but received a non-JSON response: ` +
          `${body.slice(0, 200)}`,
      );
    }

    return body as T;
  }

  /** Reads a response as JSON, falling back to text for non-JSON error pages. */
  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === '') return {};

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
