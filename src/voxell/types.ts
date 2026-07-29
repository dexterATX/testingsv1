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

/** The model used when the request omits `model`. */
export const DEFAULT_EMBED_MODEL: EmbedModel = 'turbo';

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
