/** Error types raised by the Voxell client. */

import type { ErrorAdapter } from '../http/transport.js';

/** Base class — catch this to catch anything the Voxell client throws. */
export class VoxellError extends Error {
  /** Whether the shared transport should try again. */
  readonly retryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A request rejected client-side, before it was sent. */
export class VoxellRequestValidationError extends VoxellError {}

/** Non-2xx response from the API. */
export class VoxellApiError extends VoxellError {
  readonly status: number;
  readonly requestId: string | undefined;
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

/** 400 — malformed request (empty `texts`, unknown model). */
export class VoxellBadRequestError extends VoxellApiError {}

/** 401 / 403 — missing or invalid API key. */
export class VoxellAuthError extends VoxellApiError {}

/** 413 — a single text exceeded the ~8192 token / 32000 char ceiling. */
export class VoxellPayloadTooLargeError extends VoxellApiError {}

/** 429 — rate limited. Retried automatically. */
export class VoxellRateLimitError extends VoxellApiError {
  override readonly retryable = true;

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

/** 5xx — server-side failure. Retried automatically. */
export class VoxellServerError extends VoxellApiError {
  override readonly retryable = true;
}

/** Network-level failure. Retried automatically. */
export class VoxellConnectionError extends VoxellError {
  override readonly retryable = true;
}

/** The request exceeded the configured timeout. */
export class VoxellTimeoutError extends VoxellError {
  readonly timeoutMs: number;

  constructor(message: string, init: { timeoutMs: number; cause?: unknown }) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.timeoutMs = init.timeoutMs;
  }
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
): VoxellApiError {
  const base = { status, requestId: init.requestId, body: init.body };

  if (status === 400 || status === 422) return new VoxellBadRequestError(init.message, base);
  if (status === 401 || status === 403) return new VoxellAuthError(init.message, base);
  if (status === 413) return new VoxellPayloadTooLargeError(init.message, base);
  if (status === 429) {
    return new VoxellRateLimitError(init.message, {
      ...base,
      retryAfterSeconds: init.retryAfterSeconds,
    });
  }

  if (status >= 500) return new VoxellServerError(init.message, base);

  return new VoxellApiError(init.message, base);
}

/** Lets the shared transport raise Voxell's own error classes. */
export const voxellErrorAdapter: ErrorAdapter = {
  fromStatus: (status, init) => {
    if (status === 403) {
      return new VoxellAuthError(
        `${init.message} (A Cloudflare 1010 here usually means the HTTP client's ` +
          `fingerprint was blocked rather than a bad key.)`,
        { status, requestId: init.requestId, body: init.body },
      );
    }
    return errorForStatus(status, init);
  },
  timeout: (message, init) => new VoxellTimeoutError(message, init),
  connection: (message, init) => new VoxellConnectionError(message, init),
  protocol: (message) => new VoxellError(message),
};
