/** Error types raised by the Exa client. */

import type { ErrorAdapter } from '../http/transport.js';

/** Base class — catch this to catch anything the client throws. */
export class ExaError extends Error {
  /**
   * Whether the transport should try again. Carried on the error rather than
   * inferred from its class, so the shared transport stays provider-agnostic.
   */
  readonly retryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A request rejected client-side, before it was sent.
 *
 * These mirror constraints the API documents (numResults range, category
 * filter incompatibilities, outputSchema limits), so an obvious mistake fails
 * immediately instead of costing a round trip and a 400.
 */
export class ExaRequestValidationError extends ExaError {}

/** Non-2xx response from the API. */
export class ExaApiError extends ExaError {
  readonly status: number;
  readonly requestId: string | undefined;
  /** Parsed JSON body when available, otherwise the raw text. */
  readonly body: unknown;

  constructor(
    message: string,
    init: { status: number; requestId?: string | undefined; body?: unknown },
  ) {
    super(message);
    this.status = init.status;
    this.requestId = init.requestId;
    this.body = init.body;
  }
}

/** 400 — invalid parameters or an unsupported filter combination. */
export class ExaBadRequestError extends ExaApiError {}

/** 401 — missing or invalid API key. */
export class ExaAuthError extends ExaApiError {}

/** 422 — parameter types failed validation. */
export class ExaUnprocessableError extends ExaApiError {}

/** 429 — rate limited. Retried automatically up to `maxRetries`. */
export class ExaRateLimitError extends ExaApiError {
  override readonly retryable = true;

  /** Seconds from the `Retry-After` header, when the API sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    init: {
      status: number;
      requestId?: string | undefined;
      body?: unknown;
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(message, init);
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** 5xx — server-side failure. Retried automatically up to `maxRetries`. */
export class ExaServerError extends ExaApiError {
  override readonly retryable = true;
}

/** The request exceeded the configured timeout. */
export class ExaTimeoutError extends ExaError {
  readonly timeoutMs: number;

  constructor(message: string, init: { timeoutMs: number; cause?: unknown }) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.timeoutMs = init.timeoutMs;
  }
}

/** Network-level failure (DNS, TLS, connection reset). Retried automatically. */
export class ExaConnectionError extends ExaError {
  override readonly retryable = true;
}

/** Maps an HTTP status onto the matching error class. */
export function errorForStatus(
  status: number,
  init: {
    message: string;
    requestId?: string | undefined;
    body?: unknown;
    retryAfterSeconds?: number | undefined;
  },
): ExaApiError {
  const base = { status, requestId: init.requestId, body: init.body };

  if (status === 400) return new ExaBadRequestError(init.message, base);
  if (status === 401 || status === 403) return new ExaAuthError(init.message, base);
  if (status === 422) return new ExaUnprocessableError(init.message, base);
  if (status === 429) {
    return new ExaRateLimitError(init.message, {
      ...base,
      retryAfterSeconds: init.retryAfterSeconds,
    });
  }
  if (status >= 500) return new ExaServerError(init.message, base);

  return new ExaApiError(init.message, base);
}

/** Whether a failed attempt is worth retrying. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ExaRateLimitError) return true;
  if (error instanceof ExaServerError) return true;
  if (error instanceof ExaConnectionError) return true;
  return false;
}

/** Lets the shared transport raise Exa's own error classes. */
export const exaErrorAdapter: ErrorAdapter = {
  fromStatus: (status, init) => errorForStatus(status, init),
  timeout: (message, init) =>
    new ExaTimeoutError(
      `${message} Deep search types need a longer timeout — raise \`timeoutMs\` if this is expected.`,
      init,
    ),
  connection: (message, init) => new ExaConnectionError(message, init),
  protocol: (message) => new ExaError(message),
};
