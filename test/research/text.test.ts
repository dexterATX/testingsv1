import { describe, expect, it } from 'vitest';

import { canonicalizeUrl, resultToEmbedText } from '../../src/research/text.js';
import type { ExaResult } from '../../src/exa/types.js';

function result(overrides: Partial<ExaResult> = {}): ExaResult {
  return {
    id: 'https://example.com/a',
    url: 'https://example.com/a',
    title: 'Example Title',
    ...overrides,
  };
}

describe('resultToEmbedText', () => {
  it('prefers highlights, prefixed by the title', () => {
    const text = resultToEmbedText(
      result({ highlights: ['first excerpt', 'second excerpt'], summary: 'ignored' }),
    );

    expect(text).toBe('Example Title\n\nfirst excerpt\n\nsecond excerpt');
  });

  it('falls back to the summary when there are no highlights', () => {
    expect(resultToEmbedText(result({ summary: 'a summary' }))).toBe('Example Title\n\na summary');
  });

  it('falls back to full text when there is neither', () => {
    expect(resultToEmbedText(result({ text: 'body copy' }))).toBe('Example Title\n\nbody copy');
  });

  it('can omit the title', () => {
    const text = resultToEmbedText(result({ highlights: ['excerpt'] }), { includeTitle: false });

    expect(text).toBe('excerpt');
  });

  it('collapses whitespace so joins do not waste tokens', () => {
    const text = resultToEmbedText(result({ title: 'A   B', highlights: ['x\n\n\ty'] }));

    expect(text).toBe('A B\n\nx y');
  });

  it('truncates to maxChars', () => {
    const text = resultToEmbedText(result({ highlights: ['x'.repeat(500)] }), { maxChars: 20 });

    expect(text).toHaveLength(20);
  });

  it('never returns an empty string, since Voxell 502s on blank input', () => {
    const bare = resultToEmbedText({ id: 'x', url: 'https://example.com/page', title: null });

    expect(bare).toBe('https://example.com/page');
    expect(bare.trim()).not.toBe('');
  });

  it('falls back to the title when content fields are empty strings', () => {
    expect(resultToEmbedText(result({ highlights: [], summary: '', text: '' }))).toBe(
      'Example Title',
    );
  });
});

describe('canonicalizeUrl', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a/'],
    ['https://example.com/a', 'http://example.com/a'],
    ['https://example.com/a', 'https://www.example.com/a'],
    ['https://example.com/a', 'https://example.com/a#section'],
    ['https://example.com/a', 'https://EXAMPLE.com/A'.toLowerCase()],
  ])('treats %s and %s as the same page', (left, right) => {
    expect(canonicalizeUrl(left)).toBe(canonicalizeUrl(right));
  });

  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_source=x&id=7')).toBe('example.com/a?id=7');
    expect(canonicalizeUrl('https://example.com/a?gclid=x')).toBe('example.com/a');
  });

  it('keeps genuinely different pages apart', () => {
    expect(canonicalizeUrl('https://example.com/a')).not.toBe(canonicalizeUrl('https://example.com/b'));
    expect(canonicalizeUrl('https://a.com/x')).not.toBe(canonicalizeUrl('https://b.com/x'));
  });

  it('falls back gracefully on an unparseable URL', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});
