import { describe, expect, it } from 'vitest';

import { ExaClient } from '../../src/exa/client.js';
import { VoxellClient } from '../../src/voxell/client.js';
import { researchSearch } from '../../src/research/pipeline.js';
import type { ExaResult } from '../../src/exa/types.js';

/** A unit vector at `degrees` from [1, 0], for precise similarity control. */
function atAngle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

const QUERY = 'QUERYTOPIC in production';

/**
 * Embeddings are chosen by a marker in the text, so each fixture's similarity
 * to the query is exact and the assertions are not at the mercy of a hash.
 */
const VECTOR_BY_MARKER: Array<[string, number[]]> = [
  ['ALPHA', atAngle(0)], // identical to the query direction
  ['BETA', atAngle(5)], // cos ~0.996 with ALPHA => near-duplicate
  ['GAMMA', atAngle(60)], // cos 0.5 with the query => related but distinct
  ['DELTA', atAngle(89)], // cos ~0.017 => barely relevant
  ['QUERYTOPIC', atAngle(0)],
];

function vectorFor(text: string): number[] {
  for (const [marker, vector] of VECTOR_BY_MARKER) {
    if (text.includes(marker)) return vector;
  }
  return [0, 1];
}

function makeResult(marker: string, url: string): ExaResult {
  return { id: url, url, title: marker, highlights: [`${marker} excerpt about the topic`] };
}

interface Harness {
  exa: ExaClient;
  voxell: VoxellClient;
  searchBodies: Array<Record<string, unknown>>;
  embedBodies: Array<{ texts: string[]; model?: string }>;
}

function harness(results: ExaResult[]): Harness {
  const searchBodies: Array<Record<string, unknown>> = [];
  const embedBodies: Array<{ texts: string[]; model?: string }> = [];

  const exaFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    searchBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ requestId: 'req_test', searchType: 'auto', results }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const voxellFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { texts: string[]; model?: string };
    embedBodies.push(body);
    return new Response(
      JSON.stringify({
        dim: 2,
        embeddings: body.texts.map(vectorFor),
        latency_ms: 7,
        model: 'qwen3-native-28l',
        tokens: body.texts.length * 4,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  return {
    exa: new ExaClient({ apiKey: 'exa-key', fetch: exaFetch as unknown as typeof globalThis.fetch }),
    voxell: new VoxellClient({
      apiKey: 'vox-key',
      fetch: voxellFetch as unknown as typeof globalThis.fetch,
    }),
    searchBodies,
    embedBodies,
  };
}

describe('researchSearch', () => {
  it('reranks results by semantic similarity to the query', async () => {
    // Exa returns the weakest match first; the rerank should invert that.
    const h = harness([
      makeResult('DELTA', 'https://example.com/delta'),
      makeResult('GAMMA', 'https://example.com/gamma'),
      makeResult('ALPHA', 'https://example.com/alpha'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.results.map((r) => r.result.title)).toEqual(['ALPHA', 'GAMMA', 'DELTA']);
    expect(report.results[0]!.score).toBeCloseTo(1, 6);
    expect(report.results[1]!.score).toBeCloseTo(0.5, 6);
  });

  it('reports how far the rerank moved each result', async () => {
    const h = harness([
      makeResult('DELTA', 'https://example.com/delta'),
      makeResult('ALPHA', 'https://example.com/alpha'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    // ALPHA was second, now first: promoted by one place.
    expect(report.results[0]!).toMatchObject({ originalRank: 1, rankDelta: 1 });
    expect(report.results[1]!).toMatchObject({ originalRank: 0, rankDelta: -1 });
  });

  it('embeds the query and every result in a single request', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(h.embedBodies).toHaveLength(1);
    expect(h.embedBodies[0]!.texts[0]).toBe(QUERY);
    expect(h.embedBodies[0]!.texts).toHaveLength(3);
  });

  it('collapses near-duplicates into the higher-ranked result', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('BETA', 'https://other.com/beta'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.results.map((r) => r.result.title)).toEqual(['ALPHA', 'GAMMA']);
    expect(report.results[0]!.duplicates).toHaveLength(1);
    expect(report.results[0]!.duplicates[0]!.result.title).toBe('BETA');
    expect(report.results[0]!.duplicates[0]!.similarity).toBeCloseTo(0.9962, 3);
    expect(report.stats.nearDuplicates).toBe(1);
  });

  it('keeps near-duplicates when dedupe is disabled', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('BETA', 'https://other.com/beta'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY, dedupe: false });

    expect(report.results).toHaveLength(2);
    expect(report.stats.nearDuplicates).toBe(0);
  });

  it('respects a custom dedupe threshold', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('BETA', 'https://other.com/beta'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      dedupeThreshold: 0.999,
    });

    expect(report.results).toHaveLength(2);
  });

  it('drops exact URL duplicates before spending an embedding on them', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('ALPHA', 'https://www.example.com/alpha/?utm_source=x'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.stats.retrieved).toBe(3);
    expect(report.stats.exactDuplicates).toBe(1);
    // query + 2 surviving results
    expect(h.embedBodies[0]!.texts).toHaveLength(3);
  });

  it('applies minScore', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('GAMMA', 'https://example.com/gamma'),
      makeResult('DELTA', 'https://example.com/delta'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY, minScore: 0.4 });

    expect(report.results.map((r) => r.result.title)).toEqual(['ALPHA', 'GAMMA']);
    expect(report.stats.belowThreshold).toBe(1);
  });

  it('applies topK after ranking', async () => {
    const h = harness([
      makeResult('DELTA', 'https://example.com/delta'),
      makeResult('GAMMA', 'https://example.com/gamma'),
      makeResult('ALPHA', 'https://example.com/alpha'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY, topK: 2 });

    expect(report.results.map((r) => r.result.title)).toEqual(['ALPHA', 'GAMMA']);
  });

  it('requests highlights by default and forwards search options', async () => {
    const h = harness([makeResult('ALPHA', 'https://example.com/alpha')]);

    await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      numResults: 40,
      search: { type: 'deep', includeDomains: ['arxiv.org'] },
    });

    expect(h.searchBodies[0]).toMatchObject({
      query: QUERY,
      numResults: 40,
      type: 'deep',
      includeDomains: ['arxiv.org'],
      contents: { highlights: true },
    });
  });

  it('lets the caller override the content mode', async () => {
    const h = harness([makeResult('ALPHA', 'https://example.com/alpha')]);

    await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      search: { contents: { text: { maxCharacters: 2000 } } },
    });

    expect(h.searchBodies[0]!['contents']).toEqual({ text: { maxCharacters: 2000 } });
  });

  it('reports embedding stats from the Voxell response', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.stats).toMatchObject({
      retrieved: 2,
      exactDuplicates: 0,
      embedded: 3,
      dim: 2,
      model: 'qwen3-native-28l',
      tokens: 12,
    });
  });

  it('exposes the raw Exa response for anything the pipeline dropped', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('BETA', 'https://other.com/beta'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.results).toHaveLength(1);
    expect(report.exa.results).toHaveLength(2);
    expect(report.exa.requestId).toBe('req_test');
  });

  it('returns an empty report without calling Voxell when Exa finds nothing', async () => {
    const h = harness([]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.results).toEqual([]);
    expect(report.stats.retrieved).toBe(0);
    expect(h.embedBodies).toHaveLength(0);
  });

  it('rejects an empty query', async () => {
    const h = harness([]);

    await expect(researchSearch(h.exa, h.voxell, { query: '  ' })).rejects.toThrow(
      /`query` is required/,
    );
  });

  it('passes the model through to Voxell', async () => {
    const h = harness([makeResult('ALPHA', 'https://example.com/alpha')]);

    await researchSearch(h.exa, h.voxell, { query: QUERY, model: 'pro' });

    expect(h.embedBodies[0]!.model).toBe('pro');
  });
});
