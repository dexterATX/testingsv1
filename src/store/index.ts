/**
 * Vector storage backends.
 *
 * @example
 * // Persist embeddings across runs so repeat research costs nothing.
 * const voxell = new VoxellClient({
 *   store: new FileVectorStore({ path: '.cache/vectors.jsonl' }),
 * });
 */

export { MemoryVectorStore } from './memory.js';
export type { MemoryVectorStoreOptions } from './memory.js';

export { FileVectorStore, decodeVector, encodeVector } from './file.js';
export type { FileVectorStoreOptions } from './file.js';

export { vectorKey } from './types.js';
export type { VectorStore } from './types.js';
