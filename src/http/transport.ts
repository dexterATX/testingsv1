/**
 * Shared HTTP transport: timeouts, retry with backoff, and error mapping.
 *
 * Both provider clients (Exa, Voxell) run on this. Each supplies an
 * `ErrorAdapter` so failures surface as that provider's own error classes,
 * and an auth header, since the two APIs authenticate differently.
 */

/** Builds provider-specific errors from transport-level failures. */
export interface ErrorAdapter {
  /** Maps a non-2xx response. */
  fromStatus(
    status: number,
    init: {
      message: string;
      requestId?: string | undefined;
      body?: unknown;
      retryAfterSeconds?: number | undefined;
    },
  ): Error;
  timeout(message: string, init: { timeoutMs: number; cause?: unknown }): Error;
  connection(message: string, init: { cause?: unknown }): Error;
  /** A 2xx response whose body was not the expected shape. */
  protocol(message: string): Error;
}

export interface TransportOptions {
  baseUrl: string;
  /** e.g. `{ 'x-api-key': key }` or `{ Authorization: \`Bearer ${key}\` }`. */
  authHeaders: Record<string, string>;
  errors: ErrorAdapter;
  defaultTimeoutMs: number;
  maxRetries?: number;
  retryBaseMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOverrides {
  /** Aborts the request. Combined with the internal timeout signal. */
  signal?: AbortSignal;
  /** Overrides the timeout for this call only. */
  timeoutMs?: number;
}

export interface RequestConfig extends RequestOverrides {
  path: string;
  /** Omit for GET. */
  body?: unknown;
  /** Defaults to POST. */
  method?: 'GET' | 'POST';
  /** Return the raw `Response` so the caller can read the body as a stream. */
  stream?: boolean;
}

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_MS = 500;
export const MAX_RETRY_DELAY_MS = 20_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 and 5xx are worth another attempt; 4xx will fail identically. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Combines the timeout signal with a caller-supplied one, when present. */
export function combineSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
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

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

function extractRequestId(body: unknown, response: Response): string | undefined {
  if (typeof body === 'object' && body !== null) {
    // Exa uses `requestId`, Fireworks uses `request_id`.
    for (const key of ['requestId', 'request_id'] as const) {
      const id = (body as Record<string, unknown>)[key];
      if (typeof id === 'string') return id;
    }
  }
  return response.headers.get('x-request-id') ?? undefined;
}

/** Digs the human-readable message out of the many shapes APIs use for errors. */
export function extractErrorMessage(body: unknown, status: number): string {
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

  return `Request failed with status ${status}.`;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly errors: ErrorAdapter;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authHeaders = options.authHeaders;
    this.errors = options.errors;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get url(): string {
    return this.baseUrl;
  }

  /** Sends a request, retrying transient failures with exponential backoff. */
  async request<T>(config: RequestConfig): Promise<T> {
    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(config, timeoutMs);
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error) || attempt === this.maxRetries) throw error;

        await this.sleep(this.backoffMs(attempt, error));
      }
    }

    throw lastError;
  }

  /**
   * Retryability is carried on the error rather than inferred from its class,
   * so each provider can keep its own error hierarchy.
   */
  private shouldRetry(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && (error as { retryable?: boolean }).retryable === true
    );
  }

  private backoffMs(attempt: number, error: unknown): number {
    // Honor Retry-After when the API sends one; it knows better than we do.
    const retryAfter =
      typeof error === 'object' && error !== null && 'retryAfterSeconds' in error
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

    const method = config.method ?? 'POST';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${config.path}`, {
        method,
        headers: {
          ...this.authHeaders,
          'Content-Type': 'application/json',
          Accept: config.stream ? 'text/event-stream' : 'application/json',
          ...this.extraHeaders,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(config.body) }),
        signal,
      });
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw this.errors.timeout(
          `Request to ${config.path} timed out after ${timeoutMs} ms.`,
          { timeoutMs, cause: error },
        );
      }
      // A caller-initiated abort is intentional; surface it unchanged.
      if (config.signal?.aborted) throw error;

      throw this.errors.connection(
        `Could not reach ${this.baseUrl}${config.path}.`,
        { cause: error },
      );
    } finally {
      // The streaming path keeps reading the body after this returns, but the
      // timeout only needs to cover establishing the response.
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await this.readBody(response);
      throw this.errors.fromStatus(response.status, {
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
      throw this.errors.protocol(
        `Expected JSON from ${config.path} but received a non-JSON response: ${body.slice(0, 200)}`,
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
