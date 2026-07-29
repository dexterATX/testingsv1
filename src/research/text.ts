/**
 * Turning an Exa result into the text that gets embedded.
 *
 * Highlights are the best default: they are already query-relevant excerpts,
 * so they carry the signal that matters without the token cost of full pages.
 */

import type { ExaResult } from '../exa/types.js';

export interface EmbedTextOptions {
  /**
   * Cap on the composed text. Well under Voxell's 32000-character ceiling,
   * because embedding quality degrades long before the hard limit and tokens
   * are billed either way.
   */
  maxChars?: number;
  /** Prepend the result title. Defaults to true. */
  includeTitle?: boolean;
  /**
   * Which content field to reach for first. `highlights` (the default) is
   * right for one-vector-per-result; `text` gives chunking more to work with.
   */
  prefer?: 'highlights' | 'text';
}

const DEFAULT_MAX_CHARS = 8_000;

/** Collapses runs of whitespace so excerpt joins do not waste tokens. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Composes the text to embed for a result, in descending order of usefulness:
 * highlights, then summary, then full text.
 *
 * Never returns an empty string — Voxell answers a blank input with a 502, so
 * a result with no content at all falls back to its URL.
 */
export function resultToEmbedText(result: ExaResult, options: EmbedTextOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const includeTitle = options.includeTitle ?? true;

  const parts: string[] = [];

  if (includeTitle && result.title) parts.push(tidy(result.title));

  if (options.prefer === 'text' && result.text) {
    parts.push(tidy(result.text));
  } else if (result.highlights?.length) {
    parts.push(...result.highlights.map(tidy));
  } else if (result.summary) {
    parts.push(tidy(result.summary));
  } else if (result.text) {
    parts.push(tidy(result.text));
  }

  const composed = parts.filter((part) => part !== '').join('\n\n');

  // Fall back through title then URL so the result is always embeddable.
  const text = composed || tidy(result.title ?? '') || result.url || result.id;

  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Normalizes a URL for exact-duplicate detection: drops the protocol, `www.`,
 * a trailing slash, the fragment, and common tracking parameters.
 */
export function canonicalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim().toLowerCase();
  }

  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|ref_|source$|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }

  const host = url.host.replace(/^www\./i, '');
  const path = url.pathname.replace(/\/+$/, '');
  const query = url.searchParams.toString();

  return `${host}${path}${query ? `?${query}` : ''}`.toLowerCase();
}
