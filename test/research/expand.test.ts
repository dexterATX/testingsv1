import { describe, expect, it, vi } from 'vitest';

import { expandQuery, parseExpansions } from '../../src/research/expand.js';
import type { Completer, CompletionRequest } from '../../src/synthesis/types.js';

const ORIGINAL = 'how are teams evaluating RAG retrieval quality?';

/** A completer that returns whatever text the test hands it. */
const saying = (text: string): Completer => async () => ({ text });

describe('parseExpansions', () => {
  it('takes one query per line', () => {
    const out = parseExpansions('measuring recall@k in production\nRAG golden datasets', ORIGINAL, 3);

    expect(out).toEqual(['measuring recall@k in production', 'RAG golden datasets']);
  });

  it('strips the decoration models add despite being told not to', () => {
    const text = ['1. numbered query', '- bulleted query', '* starred query', '"quoted query"'].join(
      '\n',
    );

    expect(parseExpansions(text, ORIGINAL, 5)).toEqual([
      'numbered query',
      'bulleted query',
      'starred query',
      'quoted query',
    ]);
  });

  it('recovers queries from an annotated markdown list', () => {
    // Observed live: the same model, given the same prompt, returned bare
    // lines on one call and this on the next. Both have to work, or expansion
    // silently does nothing on a coin flip.
    const text = [
      '1. **"database credential rotation best practices"** — for security guidelines',
      '',
      '2. **"how to rotate database passwords without downtime"** — for implementation',
    ].join('\n');

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual([
      'database credential rotation best practices',
      'how to rotate database passwords without downtime',
    ]);
  });

  it('keeps a hyphen that belongs to the query', () => {
    // Cutting at every dash would turn this into "zero" — a real query, badly
    // truncated, is worse than a trailing clause.
    const text = 'zero-downtime credential rotation';

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual(['zero-downtime credential rotation']);
  });

  it('drops a heading line rather than searching for it', () => {
    const text = 'Here are three alternative queries:\nretriever precision at k\nMRR in RAG';

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual(['retriever precision at k', 'MRR in RAG']);
  });

  it('drops a restatement of the original, however punctuated', () => {
    // A paraphrase that retrieves the same pages is a paid search for nothing.
    const text = `How are teams evaluating RAG retrieval quality\nsomething genuinely different`;

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual(['something genuinely different']);
  });

  it('drops duplicates within the reply', () => {
    const text = 'same query\nSame Query!\nother query';

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual(['same query', 'other query']);
  });

  it('drops prose too long to be a search query', () => {
    const text = `${'a'.repeat(250)}\nshort enough`;

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual(['short enough']);
  });

  it('never returns more than asked for', () => {
    const text = Array.from({ length: 20 }, (_, i) => `query number ${i}`).join('\n');

    expect(parseExpansions(text, ORIGINAL, 3)).toHaveLength(3);
  });

  it('returns nothing for a model that answered in prose', () => {
    // The failure this exists to catch: a chatty reply must degrade to a plain
    // single search, never to a paid search for a sentence of commentary.
    const text =
      "I'd be happy to help with that! Here's what I think about your research question:";

    expect(parseExpansions(text, ORIGINAL, 3)).toEqual([]);
  });
});

describe('expandQuery', () => {
  it('asks for the requested count and returns the queries', async () => {
    const completer = vi.fn(async (_request: CompletionRequest) => ({
      text: 'alpha query\nbeta query\ngamma query',
    }));

    const out = await expandQuery(ORIGINAL, { completer, count: 3 });

    expect(out).toEqual(['alpha query', 'beta query', 'gamma query']);
    expect(completer.mock.calls[0]![0].prompt).toContain(ORIGINAL);
    expect(completer.mock.calls[0]![0].prompt).toContain('3');
  });

  it('degrades to no expansion when the completer throws', async () => {
    // A missing key or a refusal must not stop a search the user could
    // otherwise have run.
    const completer: Completer = async () => {
      throw new Error('no API key');
    };

    await expect(expandQuery(ORIGINAL, { completer })).resolves.toEqual([]);
  });

  it('returns nothing for a blank question without calling the model', async () => {
    const completer = vi.fn(async (_request: CompletionRequest) => ({
      text: 'should not be called',
    }));

    expect(await expandQuery('   ', { completer })).toEqual([]);
    expect(completer).not.toHaveBeenCalled();
  });

  it('caps the count, so a caller cannot fan out unboundedly', async () => {
    const completer = saying(
      Array.from({ length: 30 }, (_, i) => `query ${i}`).join('\n'),
    );

    expect(await expandQuery(ORIGINAL, { completer, count: 50 })).toHaveLength(6);
  });
});
