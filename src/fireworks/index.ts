/**
 * Fireworks chat completions client.
 *
 * @example
 * import { FireworksClient } from './fireworks/index.js';
 *
 * const fw = new FireworksClient(); // reads FIREWORKS_API_KEY
 * const { text } = await fw.chat([{ role: 'user', content: 'Summarize this' }]);
 */

export { FireworksClient } from './client.js';
export type { ChatOptions, ChatResult, FireworksClientOptions } from './client.js';

export {
  FireworksError,
  FireworksApiError,
  FireworksAuthError,
  FireworksBadRequestError,
  FireworksConnectionError,
  FireworksModelNotFoundError,
  FireworksRateLimitError,
  FireworksRequestValidationError,
  FireworksServerError,
  FireworksTimeoutError,
  fireworksErrorAdapter,
} from './errors.js';

export { DEFAULT_FIREWORKS_MODEL, KNOWN_MODELS } from './types.js';

export type {
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatMessage,
  ChatRole,
  ContentPart,
  FireworksModel,
  KnownModel,
  // Prefixed: Voxell exports `ModelInfo` / `ModelsResponse` too, and the
  // top-level barrel re-exports both providers.
  ModelInfo as FireworksModelInfo,
  ModelsResponse as FireworksModelsResponse,
} from './types.js';
