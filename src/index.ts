/**
 * A research toolkit: broad retrieval via Exa, semantic precision via Voxell
 * embeddings.
 *
 * @example
 * import { ExaClient, VoxellClient, researchSearch } from 'exa-client';
 *
 * const report = await researchSearch(new ExaClient(), new VoxellClient(), {
 *   query: 'how are teams evaluating RAG pipelines in production?',
 *   numResults: 25,
 * });
 */

export * from './exa/index.js';
export * from './voxell/index.js';
export * from './research/index.js';
