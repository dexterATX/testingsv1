import { describe, expect, it } from 'vitest';

import { chunkText } from '../../src/research/chunk.js';

describe('chunkText', () => {
  it('returns nothing for blank text, which the embeddings API 502s on', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk for text under the budget', () => {
    const chunks = chunkText('short text', { maxChars: 100 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: 'short text', index: 0, start: 0 });
  });

  it('splits long text into multiple chunks', () => {
    const paragraph = 'word '.repeat(100).trim();
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

    const chunks = chunkText(text, { maxChars: 300, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(300);
  });

  it('numbers chunks sequentially from zero', () => {
    const text = 'sentence here. '.repeat(200);
    const chunks = chunkText(text, { maxChars: 200, overlapChars: 0 });

    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('prefers paragraph boundaries', () => {
    const text = `${'a'.repeat(80)}\n\n${'b'.repeat(80)}`;
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 0, minChars: 1 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe('a'.repeat(80));
    expect(chunks[1]!.text).toBe('b'.repeat(80));
  });

  it('falls back to sentence boundaries inside a long paragraph', () => {
    const sentence = `${'x'.repeat(60)}. `;
    const chunks = chunkText(sentence.repeat(6).trim(), {
      maxChars: 140,
      overlapChars: 0,
      minChars: 1,
    });

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should end at a sentence terminator, not mid-word.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.trimEnd().endsWith('.')).toBe(true);
  });

  it('hard-cuts a single sentence that exceeds the budget', () => {
    const chunks = chunkText('y'.repeat(500), { maxChars: 100, overlapChars: 0, minChars: 1 });

    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(100);
  });

  it('adds overlap to every chunk after the first', () => {
    const text = `${'a'.repeat(90)}\n\n${'b'.repeat(90)}`;
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 20, minChars: 1 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text.startsWith('a')).toBe(true);
    // The second chunk carries trailing context from the first.
    expect(chunks[1]!.text).toContain('a');
    expect(chunks[1]!.text).toContain('b');
  });

  it('merges a runt tail into the previous chunk', () => {
    const text = `${'a'.repeat(95)}\n\ntiny`;
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 0, minChars: 50 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('tiny');
  });

  it('keeps a tail that clears minChars as its own chunk', () => {
    const text = `${'a'.repeat(95)}\n\n${'b'.repeat(60)}`;
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 0, minChars: 50 });

    expect(chunks).toHaveLength(2);
  });

  it('reports offsets that locate the chunk in the source', () => {
    const text = `${'a'.repeat(90)}\n\n${'b'.repeat(90)}`;
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 0, minChars: 1 });

    for (const chunk of chunks) {
      expect(chunk.end).toBeGreaterThan(chunk.start);
      expect(chunk.end).toBeLessThanOrEqual(text.trim().length);
    }
    expect(chunks[1]!.start).toBeGreaterThan(chunks[0]!.start);
  });

  it('never emits an empty chunk', () => {
    const text = 'a\n\n\n\nb\n\n   \n\nc'.repeat(30);
    const chunks = chunkText(text, { maxChars: 50, overlapChars: 5, minChars: 1 });

    for (const chunk of chunks) expect(chunk.text.trim()).not.toBe('');
  });

  describe('option validation', () => {
    it('rejects overlap greater than or equal to maxChars, which cannot advance', () => {
      expect(() => chunkText('x'.repeat(500), { maxChars: 100, overlapChars: 100 })).toThrow(
        /must be less than/,
      );
    });

    it('rejects a non-positive maxChars', () => {
      expect(() => chunkText('x'.repeat(500), { maxChars: 0 })).toThrow(/at least 1/);
    });

    it('rejects negative overlap', () => {
      expect(() => chunkText('x'.repeat(500), { overlapChars: -1 })).toThrow(/not be negative/);
    });
  });
});
