/**
 * Client-side request validation.
 *
 * Two kinds of rule live here, and the distinction matters:
 *
 * 1. **API-enforced** — the live API returns a 400. Checking first turns a
 *    round trip into an immediate, specific error, which matters most for the
 *    deep search types where a wasted call costs seconds. Verified against the
 *    live API on 2026-07-29: `people` + `excludeDomains`, `company`/`people` +
 *    date filters, `numResults` below 1, a non-ISO `userLocation`.
 *
 * 2. **Client-side opinions** — the API accepts these and *silently ignores
 *    them*, which is worse than an error: you pay for a search that quietly
 *    did not do what you asked. Verified: content fields at the top level of
 *    `/search` return no content, and every removed parameter below is
 *    accepted and dropped (as is any unknown key — Exa ignores extras
 *    wholesale). These are deliberately stricter than the API.
 *
 * Rules that were documented but turned out not to be enforced — `company` +
 * `excludeDomains`, `additionalQueries` outside deep types — have been removed
 * rather than kept as false rejections.
 */

import { ExaRequestValidationError } from './errors.js';
import {
  CATEGORIES_WITHOUT_DATE_FILTERS,
  CATEGORIES_WITHOUT_EXCLUDE_DOMAINS,
  SEARCH_TYPES,
  type ContentsOptions,
  type JsonSchema,
  type SearchRequest,
} from './types.js';

const MAX_DOMAINS = 1200;
const MAX_SCHEMA_DEPTH = 2;
const MAX_SCHEMA_PROPERTIES = 10;
const MAX_AGE_HOURS_MAX = 720;
const MAX_LIVECRAWL_TIMEOUT_MS = 90_000;
const MAX_SUBPAGES = 100;

/**
 * Parameters that were removed or never existed, mapped to the replacement.
 *
 * The API accepts every one of these and silently drops it (verified — it
 * ignores unknown keys generally). That is the reason to reject them here: a
 * half-finished migration would otherwise look like it worked while doing
 * nothing, and you would pay for the search either way.
 */
const DEPRECATED_PARAMS: Record<string, string> = {
  useAutoprompt: 'remove it entirely — it is deprecated and does nothing',
  includeUrls: 'use `includeDomains`',
  excludeUrls: 'use `excludeDomains`',
  numSentences: 'use `contents.highlights: true`',
  highlightsPerUrl: 'use `contents.highlights: true`',
  tokensNum: 'use `contents.text.maxCharacters`',
  livecrawl: 'use `contents.maxAgeHours` (0 = always livecrawl, -1 = never)',
};

function fail(message: string): never {
  throw new ExaRequestValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) fail(`${label} must be an integer, got ${value}.`);
}

/**
 * Rejects content options that were passed at the top level of a `/search`
 * request instead of nested under `contents` — the single most common mistake,
 * and one the API answers by silently returning no content.
 */
function assertNoTopLevelContentFields(request: Record<string, unknown>): void {
  for (const field of ['text', 'highlights', 'summary'] as const) {
    if (field in request) {
      fail(
        `\`${field}\` must be nested inside \`contents\` on /search ` +
          `(e.g. { contents: { ${field}: true } }). ` +
          `On /contents it is top-level — the two endpoints differ.`,
      );
    }
  }
}

function assertNoDeprecatedParams(request: Record<string, unknown>): void {
  for (const [param, replacement] of Object.entries(DEPRECATED_PARAMS)) {
    if (param in request) {
      fail(`\`${param}\` is not a supported parameter — ${replacement}.`);
    }
  }
}

/** Depth and property-count limits on `outputSchema`. */
export function assertValidOutputSchema(schema: JsonSchema): void {
  let totalProperties = 0;

  const walk = (node: JsonSchema, depth: number): void => {
    if (node.properties) {
      const keys = Object.keys(node.properties);
      totalProperties += keys.length;

      if (depth > MAX_SCHEMA_DEPTH) {
        fail(
          `outputSchema exceeds the maximum nesting depth of ${MAX_SCHEMA_DEPTH}. ` +
            `Flatten the schema or split it across requests.`,
        );
      }

      for (const key of keys) {
        const child = node.properties[key];
        if (child) walk(child, depth + 1);
      }
    }

    if (node.items) walk(node.items, depth);
  };

  walk(schema, 1);

  if (totalProperties > MAX_SCHEMA_PROPERTIES) {
    fail(
      `outputSchema declares ${totalProperties} properties, exceeding the ` +
        `maximum of ${MAX_SCHEMA_PROPERTIES}.`,
    );
  }
}

/** Validates the `contents` block, shared by `/search` and `/contents`. */
export function assertValidContents(contents: ContentsOptions, path = 'contents'): void {
  const { maxAgeHours, livecrawlTimeout, subpages, text, highlights, summary } = contents;

  if (maxAgeHours !== undefined) {
    assertInteger(maxAgeHours, `${path}.maxAgeHours`);
    if (maxAgeHours < -1 || maxAgeHours > MAX_AGE_HOURS_MAX) {
      fail(
        `${path}.maxAgeHours must be between -1 and ${MAX_AGE_HOURS_MAX}, got ${maxAgeHours}. ` +
          `(-1 = never livecrawl, 0 = always livecrawl.)`,
      );
    }
  }

  if (livecrawlTimeout !== undefined) {
    assertInteger(livecrawlTimeout, `${path}.livecrawlTimeout`);
    if (livecrawlTimeout < 0 || livecrawlTimeout > MAX_LIVECRAWL_TIMEOUT_MS) {
      fail(
        `${path}.livecrawlTimeout must be between 0 and ${MAX_LIVECRAWL_TIMEOUT_MS} ms, ` +
          `got ${livecrawlTimeout}.`,
      );
    }
  }

  if (subpages !== undefined) {
    assertInteger(subpages, `${path}.subpages`);
    if (subpages < 0 || subpages > MAX_SUBPAGES) {
      fail(`${path}.subpages must be between 0 and ${MAX_SUBPAGES}, got ${subpages}.`);
    }
  }

  if (isPlainObject(text) && 'max_characters' in text) {
    fail(
      `${path}.text.max_characters is snake_case — the raw JSON API and the ` +
        `JavaScript client use \`maxCharacters\`. (Only the Python SDK uses snake_case.)`,
    );
  }

  if (isPlainObject(text) && typeof text['maxCharacters'] === 'number') {
    const max = text['maxCharacters'];
    if (max < 1) fail(`${path}.text.maxCharacters must be at least 1, got ${max}.`);
  }

  if (isPlainObject(highlights) && typeof highlights['maxCharacters'] === 'number') {
    const max = highlights['maxCharacters'];
    if (max < 1) fail(`${path}.highlights.maxCharacters must be at least 1, got ${max}.`);
  }

  if (isPlainObject(summary) && summary['schema']) {
    assertValidOutputSchema(summary['schema'] as JsonSchema);
  }
}

/** Validates a `/search` request. See the module header for the two rule kinds. */
export function assertValidSearchRequest(request: SearchRequest): void {
  const raw = request as unknown as Record<string, unknown>;

  assertNoDeprecatedParams(raw);
  assertNoTopLevelContentFields(raw);

  const {
    query,
    type,
    numResults,
    category,
    includeDomains,
    excludeDomains,
    startPublishedDate,
    endPublishedDate,
    outputSchema,
    userLocation,
    contents,
  } = request;

  if (typeof query !== 'string' || query.trim() === '') {
    fail('`query` is required and must be a non-empty string.');
  }

  if (type !== undefined && !SEARCH_TYPES.includes(type)) {
    // Stricter than the API on purpose: it accepts some undocumented legacy
    // values (e.g. "neural") and silently falls back on others, so a typo
    // would cost a search and return default-ranked results.
    fail(
      `Unknown search type "${type}". Expected one of: ${SEARCH_TYPES.join(', ')}. ` +
        `(This is a client-side allowlist of the documented types; the API also ` +
        `accepts some undocumented legacy values.)`,
    );
  }

  if (numResults !== undefined) {
    assertInteger(numResults, '`numResults`');
    // Only the lower bound is a fixed API rule. The ceiling is plan-dependent
    // — the API answers an over-limit request with "above what your plan
    // allows", so a hard client-side cap would block higher-tier accounts.
    if (numResults < 1) {
      fail(`\`numResults\` must be at least 1, got ${numResults}.`);
    }
  }

  for (const [name, domains] of [
    ['includeDomains', includeDomains],
    ['excludeDomains', excludeDomains],
  ] as const) {
    if (domains && domains.length > MAX_DOMAINS) {
      fail(`\`${name}\` accepts at most ${MAX_DOMAINS} entries, got ${domains.length}.`);
    }
  }

  // Category filter rules, verified against the live API. The two categories
  // differ: `people` rejects excludeDomains, `company` accepts it.
  if (category) {
    const unsupported: string[] = [];

    if (
      (CATEGORIES_WITHOUT_EXCLUDE_DOMAINS as readonly string[]).includes(category) &&
      excludeDomains !== undefined
    ) {
      unsupported.push('excludeDomains');
    }

    if ((CATEGORIES_WITHOUT_DATE_FILTERS as readonly string[]).includes(category)) {
      if (startPublishedDate !== undefined) unsupported.push('startPublishedDate');
      if (endPublishedDate !== undefined) unsupported.push('endPublishedDate');
    }

    if (unsupported.length > 0) {
      fail(
        `The "${category}" category does not support ${unsupported.join(', ')} ` +
          `and the API returns a 400. Drop the filter, or use a different category.`,
      );
    }
  }

  if (userLocation !== undefined && !/^[A-Za-z]{2}$/.test(userLocation)) {
    fail(`\`userLocation\` must be a two-letter ISO country code, got "${userLocation}".`);
  }

  if (outputSchema) assertValidOutputSchema(outputSchema);
  if (contents) assertValidContents(contents);
}

/** Validates a `/contents` request. */
export function assertValidContentsRequest(
  urls: string[],
  options: ContentsOptions = {},
): void {
  if (!Array.isArray(urls) || urls.length === 0) {
    fail('`urls` must be a non-empty array.');
  }
  if (urls.length > 100) {
    fail(`\`urls\` accepts at most 100 entries per request, got ${urls.length}.`);
  }
  for (const url of urls) {
    if (typeof url !== 'string' || url.trim() === '') {
      fail('Every entry in `urls` must be a non-empty string.');
    }
  }

  assertValidContents(options, 'options');
}
