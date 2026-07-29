/** Error types raised by the Fireworks client. */

import type { ErrorAdapter } from '../http/transport.js';

/** Base class — catch this to catch anything the Fireworks client throws. */
export class FireworksError extends Error {
  /** Whether the shared transport should try again. */
  readonly retryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A request rejected client-side, before it was sent. */
export class FireworksRequestValidationError extends FireworksError {}

/** Non-2xx response from the API. */
export class FireworksApiError extends FireworksError {
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

/** 400 / 422 — malformed request. */
export class FireworksBadRequestError extends FireworksApiError {}

/** 401 / 403 — missing or invalid API key. */
export class FireworksAuthError extends FireworksApiError {}

/** 404 — the model does not exist, is not deployed, or is not accessible. */
export class FireworksModelNotFoundError extends FireworksApiError {}

/** 429 — rate limited. Retried automatically. */
export class FireworksRateLimitError extends FireworksApiError {
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
export class FireworksServerError extends FireworksApiError {
  override readonly retryable = true;
}

/** Network-level failure. Retried automatically. */
export class FireworksConnectionError extends FireworksError {
  override readonly retryable = true;
}

/** The request exceeded the configured timeout. */
export class FireworksTimeoutError extends FireworksError {
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
): FireworksApiError {
  const base = { status, requestId: init.requestId, body: init.body };

  if (status === 400 || status === 422) return new FireworksBadRequestError(init.message, base);
  if (status === 401 || status === 403) return new FireworksAuthError(init.message, base);
  if (status === 404) {
    return new FireworksModelNotFoundError(
      `${init.message} Check the id against \`GET /v1/models\` — ids are fully ` +
        `qualified, e.g. "accounts/fireworks/models/kimi-k3".`,
      base,
    );
  }
  if (status === 429) {
    return new FireworksRateLimitError(init.message, {
      ...base,
      retryAfterSeconds: init.retryAfterSeconds,
    });
  }
  if (status >= 500) return new FireworksServerError(init.message, base);

  return new FireworksApiError(init.message, base);
}

/** Lets the shared transport raise Fireworks' own error classes. */
export const fireworksErrorAdapter: ErrorAdapter = {
  fromStatus: (status, init) => errorForStatus(status, init),
  timeout: (message, init) =>
    new FireworksTimeoutError(
      `${message} Reasoning models spend tokens before emitting any text, so a ` +
        `long generation can outlast a short timeout — raise \`timeoutMs\`.`,
      init,
    ),
  connection: (message, init) => new FireworksConnectionError(message, init),
  protocol: (message) => new FireworksError(message),
};
