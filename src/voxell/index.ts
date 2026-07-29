/**
 * Voxell embeddings API client.
 *
 * @example
 * import { VoxellClient } from './voxell/index.js';
 *
 * const voxell = new VoxellClient(); // reads VOXELL_API_KEY
 * const { embeddings } = await voxell.embed(['your text here'], { model: 'turbo' });
 */

export { VoxellClient, truncateForEmbedding } from './client.js';
export type { EmbedOptions, VoxellClientOptions } from './client.js';

export {
  VoxellError,
  VoxellApiError,
  VoxellAuthError,
  VoxellBadRequestError,
  VoxellConnectionError,
  VoxellPayloadTooLargeError,
  VoxellRateLimitError,
  VoxellRequestValidationError,
  VoxellServerError,
  VoxellTimeoutError,
  voxellErrorAdapter,
} from './errors.js';

export { DEFAULT_EMBED_MODEL, EMBED_MODELS, LIMITS, MODEL_DIMENSIONS } from './types.js';

export type {
  EmbedModel,
  EmbedModelName,
  EmbedRequest,
  EmbedResponse,
  EmbedResult,
  ModelInfo,
  ModelsResponse,
} from './types.js';
