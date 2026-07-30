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

/**
 * The publisher behind a URL, for diversity capping.
 *
 * Deliberately the registrable-ish host rather than the full origin: a vendor
 * publishing from `example.com`, `www.example.com` and `blog.example.com` is
 * one voice, and capping per-origin would let it take three slots anyway.
 *
 * Subdomains are folded into the last two labels, which is wrong for
 * `co.uk`-style suffixes — `bbc.co.uk` and `itv.co.uk` both reduce to `co.uk`
 * and would be capped as one publisher. The public-suffix list is the correct
 * fix and a dependency this library does not have, so the compound suffixes
 * common enough to matter are special-cased instead.
 */
const COMPOUND_SUFFIXES = new Set([
  'co.uk', 'ac.uk', 'gov.uk', 'org.uk', 'co.jp', 'co.nz', 'co.za', 'co.in',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'net.au', 'org.au',
]);

export function hostOf(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).host;
  } catch {
    // Not a URL we can parse — treat the whole string as its own publisher so
    // unparseable entries never collapse together under one cap.
    return rawUrl.trim().toLowerCase();
  }

  host = host.replace(/^www\./i, '').replace(/:\d+$/, '').toLowerCase();

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  const keep = COMPOUND_SUFFIXES.has(lastTwo) ? 3 : 2;

  return labels.slice(-keep).join('.');
}
