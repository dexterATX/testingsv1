/**
 * Research pipeline: Exa for breadth, Voxell embeddings for precision.
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

export { researchSearch } from './pipeline.js';
export type {
  BestChunk,
  RankedResult,
  ResearchCluster,
  ResearchOptions,
  ResearchReport,
} from './pipeline.js';

export { safeEmitter } from './events.js';
export type {
  ClusterPreview,
  RankedPreview,
  ResearchEvent,
  ResearchEventHandler,
} from './events.js';

export { chunkText } from './chunk.js';
export type { Chunk, ChunkOptions } from './chunk.js';

export { DEFAULT_CLUSTER_THRESHOLD, clusterVectors } from './cluster.js';
export type { Cluster, ClusterOptions } from './cluster.js';

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
