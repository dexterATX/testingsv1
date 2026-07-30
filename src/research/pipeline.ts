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
import type { CostDollars, ExaResult, SearchOptions, SearchResponse } from '../exa/types.js';
import type { RequestOverrides } from '../http/transport.js';
import type { VoxellClient } from '../voxell/client.js';
import type { EmbedModelName } from '../voxell/types.js';
import { chunkText, type ChunkOptions } from './chunk.js';
import { clusterVectors, type ClusterOptions } from './cluster.js';
import { safeEmitter, type ResearchEventHandler } from './events.js';
import { collapseNearDuplicates } from './dedupe.js';
import { centroid, cosineSimilarity } from './similarity.js';
import { thresholdsFor } from './thresholds.js';
import { canonicalizeUrl, hostOf, resultToEmbedText, type EmbedTextOptions } from './text.js';

export interface ResearchOptions {
  /** The research question. Used for both retrieval and re-scoring. */
  query: string;
  /** How many results to ask Exa for. Defaults to 25. */
  numResults?: number;
  /** Extra Exa search options, merged over the defaults. */
  search?: SearchOptions & RequestOverrides;
  /**
   * Additional searches whose results are merged in before ranking.
   *
   * Exa caps results per request at the plan ceiling and offers no
   * pagination, so this is the only way to widen recall. Each entry overrides
   * the base query and options, which covers both shapes that work:
   * paraphrase fan-out (a different `query`) and publication-window slicing
   * (different `startPublishedDate` / `endPublishedDate`).
   *
   * Overlap is free — exact-URL dedupe runs before anything is embedded — and
   * ranking stays anchored to the original `query`, so a paraphrase widens
   * the net without steering the order.
   *
   * @example
   * extraSearches: [
   *   { query: 'measuring retriever precision in production RAG' },
   *   { startPublishedDate: '2025-01-01T00:00:00.000Z',
   *     endPublishedDate: '2026-01-01T00:00:00.000Z' },
   * ]
   */
  extraSearches?: Array<{ query?: string } & SearchOptions>;
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
  /**
   * Fetch full page text for the top results and re-score them by their best
   * matching passage. Defaults to true.
   *
   * The first pass ranks on title plus the excerpt the search engine chose,
   * which averages away a single relevant paragraph in an otherwise unrelated
   * page. This second pass fixes that where it is read, without paying for it
   * on results nobody sees.
   */
  hydrate?: boolean;
  /**
   * How many results the second pass covers. Defaults to 25, and must be at
   * least `topK` — results outside the block are ranked on the first-pass
   * scale and cannot be interleaved with those inside it.
   */
  hydrateTopK?: number;
  /** Passages kept per hydrated result, for synthesis evidence. Defaults to 4. */
  topChunks?: number;
  /**
   * Characters of each page read for chunking and hydration. Defaults to
   * 12,000.
   *
   * This scales the run's embedding cost — and its latency — almost linearly.
   * The default keeps 29 of 30 winning passages for half the cost of reading
   * 24,000; see `DEFAULT_PAGE_CHARS`. Raise it when recall on long documents
   * matters more than speed.
   */
  pageChars?: number;
  /**
   * Most results one publisher may occupy before the rest are demoted below
   * other publishers. Defaults to 3; `0` disables the cap.
   *
   * Content dedupe cannot catch this — three different pages from one vendor
   * are genuinely different pages, they are just one voice. See the note at
   * the call site.
   */
  maxPerDomain?: number;
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
  /**
   * Best-passage similarity from the second pass, when this result was
   * hydrated. **Not comparable with `score`**, which stays on the first-pass
   * scale so `minScore` keeps meaning what the caller chose.
   */
  passageScore?: number;
  /**
   * The most relevant passages, in document order — evidence for the write-up.
   * Present only on hydrated results.
   */
  topChunks?: BestChunk[];
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
    /** Results pushed below other publishers by the per-domain cap. */
    demotedByDomain: number;
    /** Results whose full text was fetched and re-scored by best passage. */
    hydrated: number;
    /** Results in the second-pass block whose text could not be fetched. */
    hydrateFailed: number;
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
 * Permissive on purpose. High enough that a genuinely authoritative site keeps
 * its place, low enough that a vendor cannot supply a third of a comparison.
 */
const DEFAULT_MAX_PER_DOMAIN = 3;
/** Generous relative to a typical `topK`, so the block edge sits below what is read. */
const DEFAULT_HYDRATE_TOP_K = 25;
/** Passages kept per hydrated result for the write-up's evidence. */
const DEFAULT_TOP_CHUNKS = 4;
/** `contents()` has no per-type default, and a block of URLs can livecrawl. */
const HYDRATE_TIMEOUT_MS = 90_000;
/**
 * How much of each page chunking and hydration read.
 *
 * Chunking wants whole pages rather than excerpts, and this scales the run's
 * embedding cost linearly — hydration alone was 72% of a measured 139-second
 * run, embedding 408 passages.
 *
 * 12,000 rather than the 24,000 it started at. Measured over 30 top-ten
 * results across three questions, the offset at which the *winning* passage
 * was found:
 *
 * | percentile | offset |
 * |---|---:|
 * | p50 | 0 |
 * | p75 | 2,100 |
 * | p90 | 8,400 |
 * | p95 | 10,500 |
 * | p100 | 23,100 |
 *
 * Half of all winners are in the very first chunk. A 12,000 cap keeps 29 of
 * 30 for half the embedding, and the one it loses does not vanish — that
 * result falls back to its best passage inside the cap, so the cost is a worse
 * score for one result in thirty rather than a lost result.
 *
 * Deliberately not lower: 8,000 keeps 27 of 30, and a tenth of results
 * scoring on the wrong passage is a different quality of trade. Raise it with
 * `pageChars` when recall on long documents matters more than latency.
 */
const DEFAULT_PAGE_CHARS = 12_000;

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
      demotedByDomain: 0,
      hydrated: 0,
      hydrateFailed: 0,
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

/** Embedding usage from one `embed()` call, so two passes can be summed. */
interface EmbedTotals {
  embedded: number;
  tokens: number;
  latencyMs: number;
  cacheHits: number;
}

interface Survivor {
  ranked: RankedResult;
  identity: number[];
}

/**
 * Fetches full text for a block of already-ranked results and re-scores them
 * by their best-matching passage.
 *
 * Returns the block reordered. Callers must not merge this ordering with
 * results outside the block — see the note at the call site.
 */
async function hydrateBlock(
  exa: ExaClient,
  voxell: VoxellClient,
  options: {
    block: Survivor[];
    queryVector: number[];
    model: EmbedModelName | undefined;
    chunkOptions: ChunkOptions;
    topChunks: number;
    pageChars: number;
    signal?: AbortSignal;
  },
): Promise<{
  block: Survivor[];
  hydrated: number;
  failed: number;
  passages: number;
  moved: number;
  embed: EmbedTotals | undefined;
}> {
  const { block, queryVector, model, chunkOptions, topChunks, pageChars } = options;
  const before = block.map((entry) => entry.ranked.result.url);

  let contents;
  try {
    contents = await exa.contents(
      block.map((entry) => entry.ranked.result.url),
      {
        text: { maxCharacters: pageChars },
        // `contents()` has no per-type default the way `search()` does, and a
        // block of 25 URLs can livecrawl for a while.
        timeoutMs: HYDRATE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  } catch {
    // A failed fetch must not lose the run. Every result keeps the score and
    // the position the first pass gave it.
    return { block, hydrated: 0, failed: block.length, passages: 0, moved: 0, embed: undefined };
  }

  // `/contents` reports per-URL failures in `statuses` rather than throwing, so
  // an empty text field is a normal outcome, not an exception.
  const textByUrl = new Map<string, string>();
  for (const result of contents.results) {
    if (result.text && result.text.trim() !== '') {
      textByUrl.set(canonicalizeUrl(result.url), result.text);
    }
  }

  const passages: string[] = [];
  const ownerOfPassage: number[] = [];
  const indexInDoc: number[] = [];

  block.forEach((entry, docIndex) => {
    const text = textByUrl.get(canonicalizeUrl(entry.ranked.result.url));
    if (!text) return;

    const composed = resultToEmbedText(
      { ...entry.ranked.result, text },
      { prefer: 'text', maxChars: pageChars },
    );

    chunkText(composed, chunkOptions).forEach((part, partIndex) => {
      passages.push(part.text);
      ownerOfPassage.push(docIndex);
      indexInDoc.push(partIndex);
    });
  });

  if (passages.length === 0) {
    return { block, hydrated: 0, failed: block.length, passages: 0, moved: 0, embed: undefined };
  }

  const embedResult = await voxell.embed(passages, {
    ...(model ? { model } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const perDoc = block.map(() => [] as Array<{ text: string; index: number; score: number }>);
  embedResult.embeddings.forEach((vector, i) => {
    const owner = ownerOfPassage[i] as number;
    (perDoc[owner] as (typeof perDoc)[number]).push({
      text: passages[i] as string,
      index: indexInDoc[i] as number,
      score: cosineSimilarity(queryVector, vector),
    });
  });

  let hydrated = 0;
  const scored: Survivor[] = [];
  const untouched: Survivor[] = [];

  block.forEach((entry, docIndex) => {
    const chunks = perDoc[docIndex] as (typeof perDoc)[number];
    if (chunks.length === 0) {
      untouched.push(entry);
      return;
    }

    const byScore = [...chunks].sort((a, b) => b.score - a.score);
    const best = byScore[0] as (typeof byScore)[number];

    entry.ranked.passageScore = best.score;
    entry.ranked.chunkCount = chunks.length;
    entry.ranked.bestChunk = { text: best.text, index: best.index, score: best.score };
    // Best N by relevance, but emitted in document order: the write-up reads
    // them as a passage of prose, and score order scrambles the argument.
    entry.ranked.topChunks = byScore.slice(0, topChunks).sort((a, b) => a.index - b.index);

    hydrated += 1;
    scored.push(entry);
  });

  // Hydrated results order among themselves by passage score. Results whose
  // text could not be fetched have no second-pass evidence to be ranked with,
  // so they keep first-pass order and follow — a real cost of a failed fetch,
  // and the alternative is comparing two scales.
  scored.sort((a, b) => (b.ranked.passageScore ?? 0) - (a.ranked.passageScore ?? 0));
  const reordered = [...scored, ...untouched];

  const moved = reordered.reduce(
    (count, entry, index) => count + (entry.ranked.result.url === before[index] ? 0 : 1),
    0,
  );

  return {
    block: reordered,
    hydrated,
    failed: block.length - hydrated,
    passages: passages.length,
    moved,
    embed: {
      embedded: passages.length,
      tokens: embedResult.tokens,
      latencyMs: embedResult.latencyMs,
      cacheHits: embedResult.cacheHits,
    },
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
    extraSearches = [],
    dedupe = true,
    dedupeThreshold,
    maxPerDomain = DEFAULT_MAX_PER_DOMAIN,
    hydrate = true,
    hydrateTopK = DEFAULT_HYDRATE_TOP_K,
    topChunks = DEFAULT_TOP_CHUNKS,
    pageChars = DEFAULT_PAGE_CHARS,
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
    ? { text: { maxCharacters: pageChars }, highlights: true }
    : { highlights: true };

  emit({ type: 'search:start', query, numResults });

  /*
   * Fan out, then merge.
   *
   * Exa caps `numResults` per request at whatever the plan allows — 100 on the
   * measured account — and has no pagination: `offset` and friends are
   * silently ignored, returning the same window every time. The only way past
   * the ceiling is more searches.
   *
   * Two things make merging safe here rather than merely more results.
   * Exact-URL dedupe runs immediately below, so overlap costs nothing beyond
   * the search itself; and ranking scores everything against the *original*
   * query, so a paraphrase can widen recall without dragging the ordering
   * toward its own phrasing.
   *
   * Measured yield on one question: five paraphrases at 50 each returned 211
   * unique of 250 (16% overlap), and three disjoint publication windows
   * returned 150 of 150 (no overlap at all, by construction).
   */
  const searchRequests = [
    { query, options: search },
    ...extraSearches.map((extra) => {
      const { query: extraQuery, ...extraOptions } = extra;
      return { query: extraQuery ?? query, options: { ...search, ...extraOptions } };
    }),
  ];

  const searchResponses = await Promise.all(
    searchRequests.map((request) =>
      exa.search(request.query, {
        numResults,
        ...request.options,
        /*
         * Merged per key, not replaced. A caller passing `contents: { text }`
         * used to wipe `highlights` — and highlights are what the first pass
         * embeds, so the ranking would quietly fall through to a third text
         * regime none of the thresholds were calibrated on.
         */
        contents: { ...defaultContents, ...(request.options?.contents ?? {}) },
        ...(signal ? { signal } : {}),
      }),
    ),
  );

  const searchResponse = searchResponses[0] as SearchResponse;
  const mergedResults = searchResponses.flatMap((response) => response.results);
  const retrieved = mergedResults.length;

  const totalCost = searchResponses.reduce<CostDollars | undefined>((accumulated, response) => {
    if (!response.costDollars) return accumulated;
    if (!accumulated) return response.costDollars;
    return { ...accumulated, total: (accumulated.total ?? 0) + (response.costDollars.total ?? 0) };
  }, undefined);

  emit({
    type: 'search:done',
    requestId: searchResponse.requestId,
    results: mergedResults,
    costDollars: totalCost,
  });

  // Exact-URL duplicates first — free, and they would otherwise each cost an
  // embedding only to be collapsed a step later.
  const seenUrls = new Set<string>();
  const unique: ExaResult[] = [];
  for (const result of mergedResults) {
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
    ? { prefer: 'text', maxChars: pageChars, ...embedText }
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

  /*
   * Cap how much of the list any one publisher can occupy.
   *
   * Near-duplicate dedupe compares *content*, so three distinct pages from one
   * vendor survive it — they are not restatements of each other, they are one
   * voice repeated. On a comparison question that is a real distortion: the
   * site that publishes the most pages wins, and a measured run handed three
   * of ten sources to a single vendor whose own product was under comparison.
   *
   * Demote rather than drop. A capped result keeps its place in the report,
   * just below everything from a publisher that has not had its say yet, so a
   * generous `topK` still returns it and nothing is silently lost.
   *
   * This is a trade, not a free win: where one site genuinely is the authority
   * — an API's own documentation — capping it costs relevance. Hence a
   * permissive default, and 0 to switch it off.
   */
  let demotedByDomain = 0;
  if (maxPerDomain > 0 && survivors.length > 0) {
    const seenPerHost = new Map<string, number>();
    const kept: typeof survivors = [];
    const demoted: typeof survivors = [];

    for (const entry of survivors) {
      const host = hostOf(entry.ranked.result.url);
      const seen = seenPerHost.get(host) ?? 0;
      seenPerHost.set(host, seen + 1);

      if (seen < maxPerDomain) kept.push(entry);
      else demoted.push(entry);
    }

    demotedByDomain = demoted.length;
    // Demoted entries keep their relative order among themselves.
    survivors = [...kept, ...demoted];

    // `rankDelta` was computed against the pre-cap order, so recompute it or
    // the UI's ↑/↓ arrows describe a ranking that no longer exists.
    survivors.forEach((entry, index) => {
      entry.ranked.rankDelta = entry.ranked.originalRank - index;
    });
  }

  const beforeThreshold = survivors.length;
  if (minScore !== undefined) {
    survivors = survivors.filter((entry) => entry.ranked.score >= minScore);
  }
  const belowThreshold = beforeThreshold - survivors.length;

  /*
   * Second pass: fetch full page text for the results worth looking at closely,
   * chunk it, and re-score them by their best-matching passage.
   *
   * Highlights are an excerpt someone else chose. A page whose one relevant
   * paragraph sits among ten irrelevant ones scores as the average of the
   * excerpt, which is why chunking beats whole-document embedding on exactly
   * that shape (`test/live/pipeline.live.test.ts`). Doing it for every result
   * would multiply embedding volume roughly tenfold for results nobody reads,
   * so it happens here — after every cheap filter, for the top slice only.
   *
   * Two rules make this safe, and both are load-bearing:
   *
   * 1. **`identity` is never touched.** Dedupe and clustering compare identity
   *    vectors against thresholds calibrated on first-pass text. A full-text
   *    centroid points at a document's own centre of mass, a highlight vector
   *    points at the query; mixing the two populations in one threshold
   *    comparison is a category error, and clustering would group *by whether
   *    a result was hydrated* rather than by topic. Hence dedupe, the domain
   *    cap and `minScore` all run above this, on one homogeneous population.
   *
   * 2. **Re-ranking stays inside the block.** A best-of-many-passages score is
   *    not comparable with a single highlight score — max-over-chunks inflates
   *    with document length, while highlights are already a near-best-case
   *    excerpt — so promoting an unhydrated result past a hydrated one would
   *    compare two different scales. Membership of the block is decided by
   *    first-pass scores alone; ordering within it by passage scores. The cost
   *    is a discontinuity at the block edge, which is why K must exceed `topK`.
   */
  let hydrated = 0;
  let hydrateFailed = 0;
  let hydratePassages = 0;
  let hydrateMoved = 0;
  let hydrateEmbed: EmbedTotals | undefined;

  const hydrateCount = hydrate === false ? 0 : Math.min(hydrateTopK, survivors.length);

  if (hydrateCount > 0) {
    if (topK !== undefined && topK > hydrateCount && hydrate !== false) {
      throw new Error(
        `topK (${topK}) exceeds the hydrated block (${hydrateCount}), so results below the ` +
          `block would be ranked on a different scale than those inside it. Raise ` +
          `\`hydrateTopK\`, lower \`topK\`, or pass \`hydrate: false\`.`,
      );
    }

    const block = survivors.slice(0, hydrateCount);
    emit({ type: 'hydrate:start', results: block.length });

    const outcome = await hydrateBlock(exa, voxell, {
      block,
      queryVector,
      model,
      chunkOptions,
      topChunks,
      pageChars,
      ...(signal ? { signal } : {}),
    });

    hydrated = outcome.hydrated;
    hydrateFailed = outcome.failed;
    hydratePassages = outcome.passages;
    hydrateMoved = outcome.moved;
    hydrateEmbed = outcome.embed;

    survivors = [...outcome.block, ...survivors.slice(hydrateCount)];

    // Positions changed, so the arrows must describe the order returned.
    survivors.forEach((entry, index) => {
      entry.ranked.rankDelta = entry.ranked.originalRank - index;
    });

    emit({
      type: 'hydrate:done',
      hydrated,
      failed: hydrateFailed,
      passages: hydratePassages,
      moved: hydrateMoved,
    });
  }

  if (topK !== undefined) survivors = survivors.slice(0, topK);

  const results = survivors.map((entry) => entry.ranked);

  let clusters: ResearchCluster[] | undefined;
  if (cluster !== false && results.length > 0) {
    const clusterOptions: ClusterOptions =
      typeof cluster === 'object' ? cluster : { threshold: thresholds.cluster };

    const grouped = clusterVectors(
      survivors.map((entry) => entry.identity),
      clusterOptions,
    );

    /*
     * A theme is a group. Anything that is not a group is not reported.
     *
     * Two degenerate shapes come back constantly and are worth nothing to a
     * reader: one cluster holding every result, which is the result list
     * printed twice, and a crowd of one-member "themes", which is no grouping
     * at all. Both are what agglomerative clustering returns when the input is
     * a *continuum* rather than distinct groups — and one query's worth of web
     * results usually is one. Measured on twenty real results for a single
     * question, no threshold produces a balanced split: it goes from one blob
     * (≤0.75) to a blob plus singletons (0.80) to near-total fragmentation
     * (0.90), with nothing useful in between.
     *
     * So: keep only groups of two or more, and drop the lot if that leaves
     * nothing or leaves a single group that swallowed everything. An empty
     * array then means "these results have no theme structure" — a true
     * statement about the data, where a lone all-inclusive theme is a
     * misleading one.
     */
    const groups = grouped.filter((group) => group.members.length > 1);
    const swallowedEverything = groups.length === 1 && groups[0]!.members.length === results.length;

    clusters = swallowedEverything
      ? []
      : groups.map((group) => ({
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
      // Both passes, summed. Reading these off the first `embedResult` alone
      // compiles perfectly and reports about half the truth — and the half it
      // omits is the expensive half.
      embedded: passages.length + 1 + (hydrateEmbed?.embedded ?? 0),
      chunks: passages.length + (hydrateEmbed?.embedded ?? 0),
      nearDuplicates,
      demotedByDomain,
      hydrated,
      hydrateFailed,
      belowThreshold,
      dim: embedResult.dim,
      model: embedResult.model,
      tokens: embedResult.tokens + (hydrateEmbed?.tokens ?? 0),
      embedLatencyMs: embedResult.latencyMs + (hydrateEmbed?.latencyMs ?? 0),
      cacheHits: embedResult.cacheHits + (hydrateEmbed?.cacheHits ?? 0),
    },
    exa: searchResponse,
  };
}
