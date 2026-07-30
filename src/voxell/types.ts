/**
 * Request and response types for the Voxell embeddings API.
 *
 * Verified against the live API on 2026-07-29; Voxell publishes no public
 * reference docs, so the shapes here come from probing `api.voxell.ai`
 * directly. See `docs/voxell-api-reference.md` for the raw findings.
 */

/**
 * Model aliases accepted by `POST /v1/embed`.
 *
 * These are the three the API names in its own validation error. The
 * OpenAI-compatible ids from `GET /v1/models` (`forge-turbo`, `forge-pro`,
 * `forge-ultra-4k`, `text-embedding-3-small`, `text-embedding-3-large`) are
 * also accepted — see `MODEL_DIMENSIONS`.
 */
export const EMBED_MODELS = ['turbo', 'pro', 'ultra-4k'] as const;

export type EmbedModel = (typeof EMBED_MODELS)[number];

/** Any model string the API accepts, including the OpenAI-compatible aliases. */
export type EmbedModelName = EmbedModel | (string & {});

/**
 * The model this client uses when a call does not name one.
 *
 * `ultra-4k` — the top tier — rather than the API's own default of `turbo`,
 * because it separates "the same story" from "the same topic" with roughly
 * twice the margin, which is exactly the discrimination dedupe and clustering
 * need. See `src/research/thresholds.ts` for the measurements.
 *
 * It is not free: `turbo` is unmetered, `ultra-4k` bills per token. Set
 * `VOXELL_MODEL=turbo` to go back.
 */
export const DEFAULT_EMBED_MODEL: EmbedModel = 'ultra-4k';

/**
 * Output dimensions per model, measured against the live API.
 *
 * The OpenAI-named aliases do **not** match OpenAI's dimensions — Voxell maps
 * them onto its own models, so `text-embedding-3-small` returns 2560 floats
 * rather than OpenAI's 1536. Vectors from different models are not comparable;
 * re-embed a corpus if you change models.
 */
export const MODEL_DIMENSIONS: Record<string, number> = {
  turbo: 1024,
  // `ultra` is accepted alongside `ultra-4k` and returns the identical vector.
  // It is absent from the API's own validation message, which names only
  // turbo/pro/ultra-4k — measured, not documented.
  ultra: 4096,
  pro: 2560,
  'ultra-4k': 4096,
  'forge-turbo': 1024,
  'forge-pro': 2560,
  'forge-ultra-4k': 4096,
  'text-embedding-3-small': 2560,
  'text-embedding-3-large': 4096,
};

/** Hard limits enforced by the API. */
export const LIMITS = {
  /** A single text over this returns 413. */
  maxCharsPerText: 32_000,
  /** Roughly what `maxCharsPerText` corresponds to, per the 413 message. */
  maxTokensPerText: 8192,
  /**
   * Total characters across every text in one request.
   *
   * Undocumented and separate from the per-text ceiling: exceeding it returns
   * `413 Total batch size exceeds maximum (max 256000 chars across all
   * inputs)`. Measured inclusive — 256,000 succeeds, 260,000 does not.
   *
   * This binds long before `defaultBatchSize` does. A batch of 128 results at
   * the 8,000 characters `resultToEmbedText` allows is 1,024,000 characters,
   * four times over, so batching by count alone is not enough.
   */
  maxCharsPerBatch: 256_000,
  /**
   * What the client actually aims for, well under the ceiling above.
   *
   * The ceiling is what the API *rejects*, not what it serves comfortably. A
   * request at 256,000 characters was measured at 51.6 s, and a request that
   * takes the better part of a minute is exactly what an edge proxy gives up
   * on — the observed failure is `502` with a body of `error code: 502`, which
   * is the edge's own format, not the service's.
   *
   * A quarter of the ceiling puts a request in the low tens of seconds. This
   * is not slower overall: it is the *same* characters in more, smaller
   * requests, which keeps the concurrency window full instead of ending a run
   * waiting on one straggler. It also shrinks the blast radius — a failure
   * loses a quarter as much paid work.
   */
  targetCharsPerBatch: 64_000,
  /**
   * Not an API-enforced ceiling — 512 was verified working in ~3.7 s. The
   * client batches at this size by default to bound per-request latency.
   */
  defaultBatchSize: 128,
} as const;

export interface EmbedRequest {
  texts: string[];
  /** Defaults to `turbo` server-side when omitted. */
  model?: EmbedModelName;
}

export interface EmbedResponse {
  /** Dimensionality of each vector. */
  dim: number;
  /** One vector per input text, in input order. Pre-normalized to unit length. */
  embeddings: number[][];
  /** Server-side compute time, excluding network. */
  latency_ms: number;
  /** The *backing* model (e.g. `qwen3-native-28l`), not the alias you sent. */
  model: string;
  /** Total tokens consumed across all texts in the request. */
  tokens: number;
}

/** A batched embed call, aggregated back into one result. */
export interface EmbedResult {
  /** One unit-length vector per input text, in input order. */
  embeddings: number[][];
  dim: number;
  /** The backing model reported by the API. */
  model: string;
  /** Total tokens billed across every batch. */
  tokens: number;
  /** Summed server-side compute time across batches. */
  latencyMs: number;
  /** How many HTTP requests this took. */
  batches: number;
  /** Inputs served from the local cache rather than the API. */
  cacheHits: number;
}

/** An entry from `GET /v1/models`. */
export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}
