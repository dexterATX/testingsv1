/**
 * The Exa → Voxell join.
 *
 * Exa retrieves broadly; Voxell embeddings then re-score every result against
 * the query, collapse restatements of the same story, and optionally group
 * what survives into themes. Retrieval and ranking come from different models,
 * so the second pass catches results the first ranked generously — and, more
 * usefully, demotes ones that matched on keywords rather than meaning.
 */

import type { ExaClient } from '../exa/client.js';
import type { ExaResult, SearchOptions, SearchResponse } from '../exa/types.js';
import type { RequestOverrides } from '../http/transport.js';
import type { VoxellClient } from '../voxell/client.js';
import type { EmbedModelName } from '../voxell/types.js';
import { chunkText, type ChunkOptions } from './chunk.js';
import { clusterVectors, type ClusterOptions } from './cluster.js';
import { safeEmitter, type ResearchEventHandler } from './events.js';
import { collapseNearDuplicates } from './dedupe.js';
import { centroid, cosineSimilarity } from './similarity.js';
import { thresholdsFor } from './thresholds.js';
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
  /**
   * Embed each result as several passages instead of one vector, scoring it by
   * its best-matching passage. Improves precision on long pages, at the cost
   * of more embedded text. Pass `true` for defaults, or an options object.
   */
  chunk?: boolean | ChunkOptions;
  /** Collapse near-duplicates. Defaults to true. */
  dedupe?: boolean;
  /**
   * Cosine threshold for near-duplicates. Defaults to a value measured for
   * whichever embedding model is in use — see `./thresholds.ts`, and prefer
   * that over a literal here, since the right number moves with the model.
   */
  dedupeThreshold?: number;
  /** Group surviving results into themes. Pass `true` for defaults. */
  cluster?: boolean | ClusterOptions;
  /** Drop results scoring below this against the query. */
  minScore?: number;
  /** Keep only the top N after ranking and dedupe. */
  topK?: number;
  /**
   * Called as each stage completes, so a caller can show intermediate state —
   * notably the raw Exa hits, which land well before the final ranking. A
   * throwing handler is ignored rather than failing the run.
   */
  onEvent?: ResearchEventHandler;
  /** Aborts both the Exa and Voxell calls. */
  signal?: AbortSignal;
}

export interface BestChunk {
  text: string;
  /** Position of the chunk within its source document. */
  index: number;
  /** Similarity of this passage to the query. */
  score: number;
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
  /** The text that was embedded (the whole document when chunking is off). */
  embeddedText: string;
  /** With chunking on: the passage that scored highest against the query. */
  bestChunk?: BestChunk;
  /** With chunking on: how many passages this result was split into. */
  chunkCount?: number;
}

export interface ResearchCluster {
  /** Title of the most representative member — a cheap theme label. */
  label: string;
  /** Indices into `report.results`. */
  members: number[];
  /** Index into `report.results` of the most representative member. */
  exemplar: number;
  /** Mean similarity of members to the cluster centre, in [-1, 1]. */
  cohesion: number;
}

export interface ResearchReport {
  query: string;
  results: RankedResult[];
  /** Present only when `cluster` was requested. Largest theme first. */
  clusters?: ResearchCluster[];
  stats: {
    /** Results Exa returned. */
    retrieved: number;
    /** Removed because another result had the same canonical URL. */
    exactDuplicates: number;
    /** Texts sent for embedding (passages + the query itself). */
    embedded: number;
    /** Passages embedded across all results; equals result count when chunking is off. */
    chunks: number;
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
/** Chunking wants whole pages, so it asks Exa for more text per result. */
const CHUNKED_EMBED_MAX_CHARS = 24_000;

function emptyReport(
  query: string,
  searchResponse: SearchResponse,
  retrieved: number,
  exactDuplicates: number,
): ResearchReport {
  return {
    query,
    results: [],
    stats: {
      retrieved,
      exactDuplicates,
      embedded: 0,
      chunks: 0,
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

/**
 * Runs the full pipeline: search, embed, rerank, dedupe, and optionally
 * cluster.
 *
 * @example
 * const report = await researchSearch(exa, voxell, {
 *   query: 'how are teams evaluating RAG pipelines in production?',
 *   numResults: 25,
 *   chunk: true,
 *   cluster: true,
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
    chunk = false,
    dedupe = true,
    dedupeThreshold,
    cluster = false,
    minScore,
    topK,
    onEvent,
    signal,
  } = options;

  const emit = safeEmitter(onEvent);

  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('`query` is required and must be a non-empty string.');
  }

  // Thresholds follow the model, so resolve which model is actually going to
  // run before picking them — `model` here may be undefined, in which case the
  // client's own default is what the vectors will come from.
  const effectiveModel = model ?? voxell.model;
  const thresholds = thresholdsFor(effectiveModel);
  const nearDuplicateThreshold = dedupeThreshold ?? thresholds.dedupe;

  const chunking = chunk !== false;
  const chunkOptions: ChunkOptions = typeof chunk === 'object' ? chunk : {};

  // Chunking needs whole pages to be worth doing; highlights are already short.
  const defaultContents = chunking
    ? { text: { maxCharacters: CHUNKED_EMBED_MAX_CHARS }, highlights: true }
    : { highlights: true };

  emit({ type: 'search:start', query, numResults });

  const searchResponse = await exa.search(query, {
    numResults,
    contents: defaultContents,
    ...search,
    ...(signal ? { signal } : {}),
  });

  const retrieved = searchResponse.results.length;

  emit({
    type: 'search:done',
    requestId: searchResponse.requestId,
    results: searchResponse.results,
    costDollars: searchResponse.costDollars,
  });

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
  emit({ type: 'dedupe:exact', removed: exactDuplicates, kept: unique.length });

  if (unique.length === 0) {
    return emptyReport(query, searchResponse, retrieved, exactDuplicates);
  }

  const textOptions: EmbedTextOptions = chunking
    ? { prefer: 'text', maxChars: CHUNKED_EMBED_MAX_CHARS, ...embedText }
    : { ...embedText };

  const documents = unique.map((result) => resultToEmbedText(result, textOptions));

  // Flatten every passage into one request, tracking which result each came
  // from so scores can be pooled back per result.
  const passages: string[] = [];
  const ownerOfPassage: number[] = [];
  const passageIndexInDoc: number[] = [];

  documents.forEach((document, docIndex) => {
    const parts = chunking ? chunkText(document, chunkOptions) : [];
    if (parts.length === 0) {
      passages.push(document);
      ownerOfPassage.push(docIndex);
      passageIndexInDoc.push(0);
      return;
    }

    parts.forEach((part, partIndex) => {
      passages.push(part.text);
      ownerOfPassage.push(docIndex);
      passageIndexInDoc.push(partIndex);
    });
  });

  emit({ type: 'chunk:done', documents: documents.length, passages: passages.length });
  emit({ type: 'embed:start', texts: passages.length + 1 });

  // The query rides along in the same batch, so ranking costs one round trip.
  const embedResult = await voxell.embed([query, ...passages], {
    ...(model ? { model } : {}),
    ...(signal ? { signal } : {}),
  });

  emit({
    type: 'embed:done',
    dim: embedResult.dim,
    model: embedResult.model,
    tokens: embedResult.tokens,
    cacheHits: embedResult.cacheHits,
    latencyMs: embedResult.latencyMs,
  });

  const [queryVector, ...passageVectors] = embedResult.embeddings;
  if (!queryVector) throw new Error('Voxell returned no embedding for the query.');

  // Relevance is the best passage; identity (for dedupe and clustering) is the
  // whole document, so one strong paragraph cannot make two articles look like
  // the same story.
  const perDocument = documents.map(() => ({
    vectors: [] as number[][],
    best: { score: -Infinity, index: 0, text: '' },
    count: 0,
  }));

  passageVectors.forEach((vector, i) => {
    const owner = perDocument[ownerOfPassage[i] as number] as (typeof perDocument)[number];
    const score = cosineSimilarity(queryVector, vector);

    owner.vectors.push(vector);
    owner.count += 1;
    if (score > owner.best.score) {
      owner.best = {
        score,
        index: passageIndexInDoc[i] as number,
        text: passages[i] as string,
      };
    }
  });

  const scored = unique.map((result, index) => {
    const doc = perDocument[index] as (typeof perDocument)[number];
    return {
      result,
      originalRank: index,
      embeddedText: documents[index] as string,
      identity: doc.vectors.length === 1 ? (doc.vectors[0] as number[]) : centroid(doc.vectors),
      score: doc.best.score,
      best: doc.best,
      chunkCount: doc.count,
    };
  });

  // Rank by semantic similarity, keeping Exa's order as the tiebreaker.
  const rankedOrder = scored
    .map((_, index) => index)
    .sort(
      (a, b) =>
        (scored[b] as (typeof scored)[number]).score -
          (scored[a] as (typeof scored)[number]).score || a - b,
    );

  emit({
    type: 'rerank:done',
    ranked: rankedOrder.map((index, position) => {
      const entry = scored[index] as (typeof scored)[number];
      return {
        url: entry.result.url,
        title: entry.result.title ?? null,
        score: entry.score,
        originalRank: entry.originalRank,
        rankDelta: entry.originalRank - position,
        duplicateCount: 0,
      };
    }),
  });

  const groups = dedupe
    ? collapseNearDuplicates(
        scored.map((entry) => entry.identity),
        { threshold: nearDuplicateThreshold, order: rankedOrder },
      )
    : rankedOrder.map((index) => ({ representative: index, duplicates: [] }));

  let nearDuplicates = 0;
  let survivors = groups.map((group, newRank) => {
    const entry = scored[group.representative] as (typeof scored)[number];
    nearDuplicates += group.duplicates.length;

    const ranked: RankedResult = {
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

    if (chunking) {
      ranked.chunkCount = entry.chunkCount;
      ranked.bestChunk = {
        text: entry.best.text,
        index: entry.best.index,
        score: entry.best.score,
      };
    }

    return { ranked, identity: entry.identity };
  });

  emit({ type: 'dedupe:near', collapsed: nearDuplicates, kept: survivors.length });

  const beforeThreshold = survivors.length;
  if (minScore !== undefined) {
    survivors = survivors.filter((entry) => entry.ranked.score >= minScore);
  }
  const belowThreshold = beforeThreshold - survivors.length;

  if (topK !== undefined) survivors = survivors.slice(0, topK);

  const results = survivors.map((entry) => entry.ranked);

  let clusters: ResearchCluster[] | undefined;
  if (cluster !== false && results.length > 0) {
    const clusterOptions: ClusterOptions =
      typeof cluster === 'object' ? cluster : { threshold: thresholds.cluster };

    clusters = clusterVectors(
      survivors.map((entry) => entry.identity),
      clusterOptions,
    ).map((group) => ({
      label:
        (results[group.exemplar] as RankedResult).result.title ??
        (results[group.exemplar] as RankedResult).result.url,
      members: group.members,
      exemplar: group.exemplar,
      cohesion: group.cohesion,
    }));
  }

  if (clusters) {
    emit({
      type: 'cluster:done',
      clusters: clusters.map((c) => ({
        label: c.label,
        members: c.members,
        cohesion: c.cohesion,
      })),
    });
  }

  emit({ type: 'done', results: results.length });

  return {
    query,
    results,
    ...(clusters ? { clusters } : {}),
    stats: {
      retrieved,
      exactDuplicates,
      embedded: passages.length + 1,
      chunks: passages.length,
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
