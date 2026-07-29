/**
 * The Exa → Voxell join.
 *
 * Exa retrieves broadly; Voxell embeddings then re-score every result against
 * the query and collapse restatements of the same story. Retrieval and ranking
 * come from different models, so the second pass catches results the first
 * ranked generously — and, more usefully, demotes ones that matched on
 * keywords rather than meaning.
 */

import type { ExaClient } from '../exa/client.js';
import type { RequestOverrides } from '../http/transport.js';
import type { ExaResult, SearchOptions, SearchResponse } from '../exa/types.js';
import type { VoxellClient } from '../voxell/client.js';
import type { EmbedModelName } from '../voxell/types.js';
import { DEFAULT_DEDUPE_THRESHOLD, collapseNearDuplicates } from './dedupe.js';
import { cosineSimilarity } from './similarity.js';
import { canonicalizeUrl, resultToEmbedText, type EmbedTextOptions } from './text.js';

export interface ResearchOptions {
  /** The research question. Used for both retrieval and re-scoring. */
  query: string;
  /** How many results to ask Exa for. Defaults to 25. */
  numResults?: number;
  /** Extra Exa search options, merged over the defaults. */
  search?: SearchOptions & RequestOverrides;
  /** Embedding model. Defaults to the Voxell client's default. */
  model?: EmbedModelName;
  /** How each result is turned into embeddable text. */
  embedText?: EmbedTextOptions;
  /** Collapse near-duplicates. Defaults to true. */
  dedupe?: boolean;
  /** Cosine threshold for near-duplicates. Defaults to 0.92. */
  dedupeThreshold?: number;
  /** Drop results scoring below this against the query. */
  minScore?: number;
  /** Keep only the top N after ranking and dedupe. */
  topK?: number;
  /** Aborts both the Exa and Voxell calls. */
  signal?: AbortSignal;
}

export interface RankedResult {
  result: ExaResult;
  /** Cosine similarity to the query embedding, in [-1, 1]. */
  score: number;
  /** 0-based position in Exa's original ranking. */
  originalRank: number;
  /** How far this moved: positive means the rerank promoted it. */
  rankDelta: number;
  /** Results collapsed into this one as near-duplicates. */
  duplicates: Array<{ result: ExaResult; similarity: number }>;
  /** The text that was actually embedded. */
  embeddedText: string;
}

export interface ResearchReport {
  query: string;
  results: RankedResult[];
  stats: {
    /** Results Exa returned. */
    retrieved: number;
    /** Removed because another result had the same canonical URL. */
    exactDuplicates: number;
    /** Texts sent for embedding (results + the query itself). */
    embedded: number;
    /** Results absorbed into a near-duplicate group. */
    nearDuplicates: number;
    /** Dropped by `minScore`. */
    belowThreshold: number;
    dim: number;
    /** Backing model reported by Voxell. */
    model: string;
    tokens: number;
    embedLatencyMs: number;
    cacheHits: number;
  };
  /** The raw Exa response, for anything the pipeline discarded. */
  exa: SearchResponse;
}

const DEFAULT_NUM_RESULTS = 25;

/**
 * Runs the full pipeline: search, embed, rerank, dedupe.
 *
 * @example
 * const report = await researchSearch(exa, voxell, {
 *   query: 'how are teams evaluating RAG pipelines in production?',
 *   numResults: 25,
 *   topK: 10,
 * });
 */
export async function researchSearch(
  exa: ExaClient,
  voxell: VoxellClient,
  options: ResearchOptions,
): Promise<ResearchReport> {
  const {
    query,
    numResults = DEFAULT_NUM_RESULTS,
    search = {},
    model,
    embedText,
    dedupe = true,
    dedupeThreshold = DEFAULT_DEDUPE_THRESHOLD,
    minScore,
    topK,
    signal,
  } = options;

  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('`query` is required and must be a non-empty string.');
  }

  // Highlights are what gets embedded, so ask for them unless the caller
  // deliberately chose a different content mode.
  const searchResponse = await exa.search(query, {
    numResults,
    contents: { highlights: true },
    ...search,
    ...(signal ? { signal } : {}),
  });

  const retrieved = searchResponse.results.length;

  // Exact-URL duplicates first — free, and they would otherwise each cost an
  // embedding only to be collapsed a step later.
  const seenUrls = new Set<string>();
  const unique: ExaResult[] = [];
  for (const result of searchResponse.results) {
    const key = canonicalizeUrl(result.url);
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    unique.push(result);
  }

  const exactDuplicates = retrieved - unique.length;

  if (unique.length === 0) {
    return {
      query,
      results: [],
      stats: {
        retrieved,
        exactDuplicates,
        embedded: 0,
        nearDuplicates: 0,
        belowThreshold: 0,
        dim: 0,
        model: '',
        tokens: 0,
        embedLatencyMs: 0,
        cacheHits: 0,
      },
      exa: searchResponse,
    };
  }

  const texts = unique.map((result) => resultToEmbedText(result, embedText));

  // The query rides along in the same batch, so ranking costs one round trip.
  const embedResult = await voxell.embed([query, ...texts], {
    ...(model ? { model } : {}),
    ...(signal ? { signal } : {}),
  });

  const [queryVector, ...resultVectors] = embedResult.embeddings;
  if (!queryVector) throw new Error('Voxell returned no embedding for the query.');

  const scored = unique.map((result, index) => ({
    result,
    originalRank: index,
    embeddedText: texts[index] as string,
    vector: resultVectors[index] as number[],
    score: cosineSimilarity(queryVector, resultVectors[index] as number[]),
  }));

  // Rank by semantic similarity, keeping Exa's order as the tiebreaker.
  const rankedOrder = scored
    .map((_, index) => index)
    .sort(
      (a, b) =>
        (scored[b] as (typeof scored)[number]).score -
          (scored[a] as (typeof scored)[number]).score || a - b,
    );

  const groups = dedupe
    ? collapseNearDuplicates(
        scored.map((entry) => entry.vector),
        { threshold: dedupeThreshold, order: rankedOrder },
      )
    : rankedOrder.map((index) => ({ representative: index, duplicates: [] }));

  let nearDuplicates = 0;
  let results: RankedResult[] = groups.map((group, newRank) => {
    const entry = scored[group.representative] as (typeof scored)[number];
    nearDuplicates += group.duplicates.length;

    return {
      result: entry.result,
      score: entry.score,
      originalRank: entry.originalRank,
      rankDelta: entry.originalRank - newRank,
      duplicates: group.duplicates.map((duplicate) => ({
        result: (scored[duplicate.index] as (typeof scored)[number]).result,
        similarity: duplicate.similarity,
      })),
      embeddedText: entry.embeddedText,
    };
  });

  const beforeThreshold = results.length;
  if (minScore !== undefined) {
    results = results.filter((entry) => entry.score >= minScore);
  }
  const belowThreshold = beforeThreshold - results.length;

  if (topK !== undefined) results = results.slice(0, topK);

  return {
    query,
    results,
    stats: {
      retrieved,
      exactDuplicates,
      embedded: texts.length + 1,
      nearDuplicates,
      belowThreshold,
      dim: embedResult.dim,
      model: embedResult.model,
      tokens: embedResult.tokens,
      embedLatencyMs: embedResult.latencyMs,
      cacheHits: embedResult.cacheHits,
    },
    exa: searchResponse,
  };
}
