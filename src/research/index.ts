/**
 * Research pipeline: Exa for breadth, Voxell embeddings for precision.
 *
 * @example
 * const report = await researchSearch(exa, voxell, {
 *   query: 'how are teams evaluating RAG pipelines in production?',
 *   numResults: 25,
 *   topK: 10,
 * });
 */

export { researchSearch } from './pipeline.js';
export type { RankedResult, ResearchOptions, ResearchReport } from './pipeline.js';

export { DEFAULT_DEDUPE_THRESHOLD, collapseNearDuplicates } from './dedupe.js';
export type { DedupeOptions, DuplicateGroup, DuplicateOf } from './dedupe.js';

export {
  centroid,
  cosineSimilarity,
  dot,
  isNormalized,
  magnitude,
  normalize,
  topK,
} from './similarity.js';
export type { ScoredIndex } from './similarity.js';

export { canonicalizeUrl, resultToEmbedText } from './text.js';
export type { EmbedTextOptions } from './text.js';
