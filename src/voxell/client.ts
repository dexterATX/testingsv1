/**
 * A typed, dependency-free client for the Voxell embeddings API.
 *
 * Voxell publishes no public reference docs, so every shape and limit encoded
 * here was verified against the live API. See `docs/voxell-api-reference.md`.
 *
 * Three properties of the API shape this client:
 *
 * - **Vectors are L2-normalized**, so cosine similarity is a plain dot product.
 * - **An identical request returns an identical vector**, which is what makes
 *   the cache and the in-request dedupe sound. The same text embedded in a
 *   *differently shaped* batch can differ by ~6e-4 per component (cosine
 *   between the variants stays above 0.99998) — batched inference picks
 *   different kernels per padded tensor shape. That is far below any ranking
 *   or dedupe threshold, but it does mean vectors are not bit-reproducible
 *   across batch shapes: do not key a hash or an equality check on them.
 * - **An empty string returns a 502**, so blank inputs are rejected up front.
 */

import { HttpTransport, type RequestOverrides } from '../http/transport.js';
import { VoxellError, VoxellRequestValidationError, voxellErrorAdapter } from './errors.js';
import {
  DEFAULT_EMBED_MODEL,
  LIMITS,
  MODEL_DIMENSIONS,
  type EmbedModelName,
  type EmbedResponse,
  type EmbedResult,
  type ModelsResponse,
} from './types.js';

export type { RequestOverrides };

const DEFAULT_BASE_URL = 'https://api.voxell.ai';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_CACHE_ENTRIES = 10_000;

export interface VoxellClientOptions {
  /** Defaults to `process.env.VOXELL_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.VOXELL_BASE_URL` or `https://api.voxell.ai`. */
  baseUrl?: string;
  /** Default model for `embed()`. Defaults to `turbo`. */
  model?: EmbedModelName;
  /** Texts per HTTP request. Defaults to 128. */
  batchSize?: number;
  /** Batches in flight at once. Defaults to 4. */
  concurrency?: number;
  /** Per-request timeout in ms. Defaults to 60000. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors. Defaults to 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Defaults to 500. */
  retryBaseMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * Cache vectors in memory across calls. Defaults to true. Saves a round trip
   * and the tokens; the cached vector may differ from a fresh one by ~6e-4 per
   * component if the batch shape differs, which no threshold in this library
   * is sensitive to.
   */
  cache?: boolean;
  /** Cache entry ceiling before oldest-first eviction. Defaults to 10000. */
  maxCacheEntries?: number;
  /**
   * What to do with a text over the API's 32000-character ceiling:
   * `'error'` (default) throws, `'truncate'` clips it and proceeds.
   */
  onOversizedText?: 'error' | 'truncate';
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests, so backoff does not make suites slow. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EmbedOptions extends RequestOverrides {
  /** Overrides the client's default model for this call. */
  model?: EmbedModelName;
  /** Overrides the client's batch size for this call. */
  batchSize?: number;
}

/** Clips to `maxChars` without leaving a dangling surrogate half. */
export function truncateForEmbedding(
  text: string,
  maxChars: number = LIMITS.maxCharsPerText,
): string {
  if (text.length <= maxChars) return text;

  const clipped = text.slice(0, maxChars);
  const lastCode = clipped.charCodeAt(clipped.length - 1);
  // A high surrogate at the very end lost its pair; drop it.
  const endsMidPair = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return endsMidPair ? clipped.slice(0, -1) : clipped;
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );

  return results;
}

export class VoxellClient {
  private readonly transport: HttpTransport;
  private readonly defaultModel: EmbedModelName;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly onOversizedText: 'error' | 'truncate';
  private readonly cache: Map<string, number[]> | undefined;
  private readonly maxCacheEntries: number;

  constructor(options: VoxellClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env['VOXELL_API_KEY'];

    if (!apiKey) {
      throw new VoxellRequestValidationError(
        'Missing Voxell API key. Set VOXELL_API_KEY in the environment (see .env.example) ' +
          'or pass `new VoxellClient({ apiKey })`.',
      );
    }

    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') {
      throw new VoxellError('No global fetch available. Use Node 18+ or pass `fetch` explicitly.');
    }

    this.defaultModel = options.model ?? DEFAULT_EMBED_MODEL;
    this.batchSize = options.batchSize ?? LIMITS.defaultBatchSize;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.onOversizedText = options.onOversizedText ?? 'error';
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.cache = options.cache === false ? undefined : new Map();

    if (this.batchSize < 1) {
      throw new VoxellRequestValidationError('`batchSize` must be at least 1.');
    }

    this.transport = new HttpTransport({
      baseUrl: options.baseUrl ?? process.env['VOXELL_BASE_URL'] ?? DEFAULT_BASE_URL,
      // The raw key alone is rejected — this API requires the Bearer prefix.
      authHeaders: { Authorization: `Bearer ${apiKey}` },
      errors: voxellErrorAdapter,
      defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });
  }

  /** Expected dimensionality for a model, or `undefined` if unmeasured. */
  static dimensionsFor(model: EmbedModelName): number | undefined {
    return MODEL_DIMENSIONS[model];
  }

  /**
   * Embeds one or more texts, returning unit-length vectors in input order.
   *
   * Repeated texts within a call are embedded once and fanned back out, and
   * batches are dispatched concurrently, so passing the whole corpus at once
   * is both correct and the fastest path.
   */
  async embed(texts: string[], options: EmbedOptions = {}): Promise<EmbedResult> {
    const model = options.model ?? this.defaultModel;
    const batchSize = options.batchSize ?? this.batchSize;
    const prepared = this.validateAndPrepare(texts);

    // Repeated text within one request would return the same vector, so embed
    // the uniques and fan the results back out.
    const uniqueTexts: string[] = [];
    const indexOfText = new Map<string, number>();
    const slotForInput: number[] = [];

    for (const text of prepared) {
      let slot = indexOfText.get(text);
      if (slot === undefined) {
        slot = uniqueTexts.length;
        indexOfText.set(text, slot);
        uniqueTexts.push(text);
      }
      slotForInput.push(slot);
    }

    const vectors = new Array<number[] | undefined>(uniqueTexts.length);
    const misses: number[] = [];
    let cacheHits = 0;

    for (let i = 0; i < uniqueTexts.length; i += 1) {
      const cached = this.cacheGet(model, uniqueTexts[i] as string);
      if (cached) {
        vectors[i] = cached;
        cacheHits += 1;
      } else {
        misses.push(i);
      }
    }

    const batches: number[][] = [];
    for (let i = 0; i < misses.length; i += batchSize) {
      batches.push(misses.slice(i, i + batchSize));
    }

    const responses = await mapWithConcurrency(batches, this.concurrency, (batch) =>
      this.postEmbed(
        batch.map((slot) => uniqueTexts[slot] as string),
        model,
        options,
      ),
    );

    let dim = MODEL_DIMENSIONS[model] ?? 0;
    let backingModel = model;
    let tokens = 0;
    let latencyMs = 0;

    for (const [batchIndex, response] of responses.entries()) {
      const batch = batches[batchIndex] as number[];

      if (response.embeddings.length !== batch.length) {
        throw new VoxellError(
          `Voxell returned ${response.embeddings.length} embeddings for ${batch.length} texts.`,
        );
      }

      for (const [offset, slot] of batch.entries()) {
        const vector = response.embeddings[offset] as number[];
        vectors[slot] = vector;
        this.cacheSet(model, uniqueTexts[slot] as string, vector);
      }

      dim = response.dim;
      backingModel = response.model;
      tokens += response.tokens ?? 0;
      latencyMs += response.latency_ms ?? 0;
    }

    return {
      embeddings: slotForInput.map((slot) => vectors[slot] as number[]),
      dim,
      model: backingModel,
      tokens,
      latencyMs,
      batches: batches.length,
      cacheHits,
    };
  }

  /** Embeds a single text and returns just the vector. */
  async embedOne(text: string, options: EmbedOptions = {}): Promise<number[]> {
    const { embeddings } = await this.embed([text], options);
    return embeddings[0] as number[];
  }

  /** `GET /v1/models` — the model ids this key can use. */
  async models(options: RequestOverrides = {}): Promise<ModelsResponse> {
    return this.transport.request<ModelsResponse>({
      path: '/v1/models',
      method: 'GET',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  /** Drops every cached vector. */
  clearCache(): void {
    this.cache?.clear();
  }

  private async postEmbed(
    texts: string[],
    model: EmbedModelName,
    options: EmbedOptions,
  ): Promise<EmbedResponse> {
    const response = await this.transport.request<EmbedResponse>({
      path: '/v1/embed',
      body: { texts, model },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    if (!Array.isArray(response?.embeddings)) {
      throw new VoxellError('Voxell response did not contain an `embeddings` array.');
    }

    return response;
  }

  /** Enforces the input rules the API cares about, before spending a request. */
  private validateAndPrepare(texts: string[]): string[] {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new VoxellRequestValidationError('`texts` must be a non-empty array.');
    }

    return texts.map((text, index) => {
      if (typeof text !== 'string') {
        throw new VoxellRequestValidationError(
          `texts[${index}] must be a string, got ${typeof text}.`,
        );
      }

      // The API answers a blank string with a 502 rather than a 400, which
      // reads as an outage. Reject it here so the cause is obvious.
      if (text.trim() === '') {
        throw new VoxellRequestValidationError(
          `texts[${index}] is empty or whitespace-only. Voxell returns a 502 for blank ` +
            `input — filter empty strings out before embedding.`,
        );
      }

      if (text.length > LIMITS.maxCharsPerText) {
        if (this.onOversizedText === 'truncate') return truncateForEmbedding(text);

        throw new VoxellRequestValidationError(
          `texts[${index}] is ${text.length} characters, over the ${LIMITS.maxCharsPerText} ` +
            `limit (~${LIMITS.maxTokensPerText} tokens); the API returns 413. Chunk the text, ` +
            `or construct the client with { onOversizedText: 'truncate' }.`,
        );
      }

      return text;
    });
  }

  private cacheKey(model: EmbedModelName, text: string): string {
    return `${model} ${text}`;
  }

  private cacheGet(model: EmbedModelName, text: string): number[] | undefined {
    return this.cache?.get(this.cacheKey(model, text));
  }

  private cacheSet(model: EmbedModelName, text: string, vector: number[]): void {
    if (!this.cache) return;

    if (this.cache.size >= this.maxCacheEntries) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }

    this.cache.set(this.cacheKey(model, text), vector);
  }
}
