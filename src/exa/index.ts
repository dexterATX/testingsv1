/**
 * Exa search API client.
 *
 * @example
 * import { ExaClient } from './exa/index.js';
 *
 * const exa = new ExaClient(); // reads EXA_API_KEY
 * const res = await exa.search('your search query here', {
 *   type: 'auto',
 *   numResults: 10,
 *   contents: { highlights: true },
 * });
 */

export { ExaClient } from './client.js';
export type { ExaClientOptions, RequestOverrides } from './client.js';

export {
  ExaError,
  ExaApiError,
  ExaAuthError,
  ExaBadRequestError,
  ExaConnectionError,
  ExaRateLimitError,
  ExaRequestValidationError,
  ExaServerError,
  ExaTimeoutError,
  ExaUnprocessableError,
  errorForStatus,
  exaErrorAdapter,
  isRetryable,
} from './errors.js';

export { parseEventStream, parseSearchStream, streamText } from './stream.js';

export {
  assertValidContents,
  assertValidContentsRequest,
  assertValidOutputSchema,
  assertValidSearchRequest,
} from './validate.js';

export {
  CATEGORIES,
  CATEGORIES_WITHOUT_FILTERS,
  DEEP_SEARCH_TYPES,
  SEARCH_TYPES,
} from './types.js';

export type {
  AnswerOptions,
  AnswerResponse,
  Category,
  ContentsOptions,
  ContentsRequestOptions,
  ContentsResponse,
  ContentsStatus,
  CostDollars,
  DeepSearchType,
  ExaOutput,
  ExaResult,
  ExtrasOptions,
  GroundingCitation,
  GroundingEntry,
  HighlightsOptions,
  JsonSchema,
  PageSection,
  SearchOptions,
  SearchRequest,
  SearchResponse,
  SearchType,
  StreamChunk,
  SummaryOptions,
  TextOptions,
  TextVerbosity,
} from './types.js';
