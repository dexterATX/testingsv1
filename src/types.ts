/**
 * Request and response types for the Exa API.
 *
 * Field names mirror the raw JSON API exactly (camelCase), so anything in the
 * Exa docs can be passed through without translation.
 *
 * Reference: https://exa.ai/docs/reference/search-api-guide-for-coding-agents
 */

/** Search types, ordered from lowest to highest latency/depth. */
export const SEARCH_TYPES = [
  'instant',
  'fast',
  'auto',
  'deep-lite',
  'deep',
  'deep-reasoning',
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/**
 * Deep variants. Only these accept `additionalQueries`, and only these do
 * multi-step planning across sources.
 */
export const DEEP_SEARCH_TYPES = ['deep-lite', 'deep', 'deep-reasoning'] as const;

export type DeepSearchType = (typeof DEEP_SEARCH_TYPES)[number];

export const CATEGORIES = [
  'company',
  'people',
  'publication',
  'news',
  'personal site',
  'financial report',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Categories that reject `excludeDomains`, `startPublishedDate`, and
 * `endPublishedDate` with a 400. See `assertValidSearchRequest`.
 */
export const CATEGORIES_WITHOUT_FILTERS = ['company', 'people'] as const;

/** `compact` strips navbars/banners/footers; `full` keeps the whole page. */
export type TextVerbosity = 'compact' | 'standard' | 'full';

export type PageSection =
  | 'header'
  | 'navigation'
  | 'banner'
  | 'body'
  | 'sidebar'
  | 'footer'
  | 'metadata';

export interface TextOptions {
  /** Hard cap on extracted characters. Documented range: 1–10000. */
  maxCharacters?: number;
  /** Preserve HTML structure — useful for code blocks and tables. */
  includeHtmlTags?: boolean;
  /** Defaults to `compact` (main content only). */
  verbosity?: TextVerbosity;
  includeSections?: PageSection[];
  excludeSections?: PageSection[];
}

export interface HighlightsOptions {
  /** Bias highlight selection toward a question other than the main query. */
  query?: string;
  /** Cap on total highlight characters per URL. Documented range: 1–10000. */
  maxCharacters?: number;
}

export interface SummaryOptions {
  /** Bias the summary toward a specific question. */
  query?: string;
  /** JSON Schema for a structured per-result summary. */
  schema?: JsonSchema;
}

export interface ExtrasOptions {
  links?: number;
  imageLinks?: number;
  richLinks?: number;
  richImageLinks?: number;
  codeBlocks?: number;
}

/**
 * Content retrieval options. On `/search` these nest under `contents`; on
 * `/contents` the same fields are top-level.
 *
 * Pick one of `text`, `highlights`, or `summary` by default — combining them
 * multiplies token cost for usually-redundant content.
 */
export interface ContentsOptions {
  text?: boolean | TextOptions;
  highlights?: boolean | HighlightsOptions;
  summary?: boolean | SummaryOptions;
  /**
   * Max acceptable age of cached content, in hours. Documented range: -1–720.
   * - `0` — always livecrawl (ignore cache); adds latency
   * - `-1` — never livecrawl (cache only); fastest
   * - omitted — livecrawl only as a fallback when nothing is cached (recommended)
   */
  maxAgeHours?: number;
  /** Livecrawl timeout in milliseconds. Documented range: 0–90000, default 10000. */
  livecrawlTimeout?: number;
  /** Number of subpages to crawl per result. Documented range: 0–100. */
  subpages?: number;
  subpageTarget?: string | string[];
  extras?: ExtrasOptions;
}

/**
 * A JSON Schema fragment, as accepted by `outputSchema` and `summary.schema`.
 *
 * Exa constrains `outputSchema` to max nesting depth 2 and max 10 total
 * properties. Do not add citation or confidence fields — `/search` returns
 * `output.grounding` automatically.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

/** Everything accepted by `POST /search` except the query itself. */
export interface SearchOptions {
  /** Defaults to `auto`. */
  type?: SearchType;
  /** Documented range: 1–100, default 10. */
  numResults?: number;
  category?: Category;
  /** Two-letter ISO country code. */
  userLocation?: string;
  /** Max 1200 entries. Supports `*.subdomain.com` wildcards. */
  includeDomains?: string[];
  /** Max 1200 entries. Rejected for the `company` and `people` categories. */
  excludeDomains?: string[];
  /** ISO 8601. Rejected for the `company` and `people` categories. */
  startPublishedDate?: string;
  /** ISO 8601. Rejected for the `company` and `people` categories. */
  endPublishedDate?: string;
  moderation?: boolean;
  /** Forced query angles. Deep variants only. */
  additionalQueries?: string[];
  /** Steers source preference, dedupe behavior, and synthesis rules. */
  systemPrompt?: string;
  /** Shape of `output.content`. Works on every search type. */
  outputSchema?: JsonSchema;
  /** Enterprise-only. Set to `'hipaa'` for HIPAA mode. */
  compliance?: 'hipaa';
  contents?: ContentsOptions;
}

export interface SearchRequest extends SearchOptions {
  query: string;
  /** Set by `searchStream`; do not pass to `search`. */
  stream?: boolean;
}

export interface ExaResult {
  id: string;
  url: string;
  title: string | null;
  publishedDate?: string | null;
  author?: string | null;
  image?: string;
  favicon?: string;
  /** Present when `contents.text` was requested. */
  text?: string;
  /** Present when `contents.highlights` was requested. */
  highlights?: string[];
  highlightScores?: number[];
  /** Present when `contents.summary` was requested. */
  summary?: string;
  subpages?: ExaResult[];
  extras?: { links?: string[]; imageLinks?: string[]; [key: string]: unknown };
}

export interface GroundingCitation {
  url: string;
  title?: string;
}

export interface GroundingEntry {
  /** Dotted path into `output.content`, e.g. `companies[0].name`. */
  field: string;
  citations: GroundingCitation[];
  confidence: 'low' | 'medium' | 'high';
}

/** Present only when `outputSchema` was supplied. */
export interface ExaOutput<T = unknown> {
  /** Matches your schema — a string for `{"type": "text"}` schemas. */
  content: T;
  grounding: GroundingEntry[];
}

export interface CostDollars {
  total: number;
  search?: Record<string, number>;
  contents?: Record<string, number>;
  [key: string]: unknown;
}

export interface SearchResponse<T = unknown> {
  requestId: string;
  searchType?: string;
  results: ExaResult[];
  output?: ExaOutput<T>;
  costDollars?: CostDollars;
}

/**
 * Options for `POST /contents`. Note these are top-level here, unlike
 * `/search`, where the same fields nest under `contents`.
 */
export interface ContentsRequestOptions extends ContentsOptions {
  compliance?: 'hipaa';
}

export interface ContentsStatus {
  id: string;
  status: 'success' | 'error';
  source?: 'cached' | 'crawled';
  error?: {
    tag: string;
    httpStatusCode: number | null;
  } | null;
}

export interface ContentsResponse {
  requestId: string;
  results: ExaResult[];
  /** Per-URL outcome. Check this before trusting `results` to be complete. */
  statuses?: ContentsStatus[];
  costDollars?: CostDollars;
}

export interface AnswerOptions {
  /** Include full page text on each citation. */
  text?: boolean;
  /** Return a structured answer instead of prose. */
  outputSchema?: JsonSchema;
}

export interface AnswerResponse<T = string> {
  requestId: string;
  /** A string, or an object matching `outputSchema` when one was supplied. */
  answer: T;
  citations: ExaResult[];
  costDollars?: CostDollars;
}

/**
 * One SSE chunk from a streaming search. Shaped like an OpenAI
 * chat-completion chunk.
 */
export interface StreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  /** Exa attaches search results and grounding to chunks as they resolve. */
  results?: ExaResult[];
  output?: ExaOutput;
  costDollars?: CostDollars;
  [key: string]: unknown;
}
