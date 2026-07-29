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

/**
 * A result whose full text buries one relevant passage in filler — the shape
 * chunking exists to handle.
 */
function makeLongResult(marker: string, url: string): ExaResult {
  const filler = `${'IRRELEVANT padding sentence about unrelated matters. '.repeat(20)}`;
  return {
    id: url,
    url,
    title: 'A long document',
    highlights: ['a short highlight'],
    text: `${filler}\n\n${marker} is discussed in detail in this passage.\n\n${filler}`,
  };
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

describe('researchSearch with chunking', () => {
  it('splits long results into passages and scores by the best one', async () => {
    const h = harness([makeLongResult('ALPHA', 'https://example.com/long')]);

    const report = await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      chunk: { maxChars: 400, overlapChars: 0 },
    });

    const entry = report.results[0]!;
    expect(entry.chunkCount).toBeGreaterThan(1);
    expect(entry.bestChunk).toBeDefined();
    // The winning passage is the one that actually mentions the topic.
    expect(entry.bestChunk!.text).toContain('ALPHA');
    expect(entry.bestChunk!.score).toBeCloseTo(1, 6);
  });

  it('asks Exa for full text when chunking, and highlights when not', async () => {
    const withChunks = harness([makeLongResult('ALPHA', 'https://example.com/long')]);
    await researchSearch(withChunks.exa, withChunks.voxell, { query: QUERY, chunk: true });
    expect(withChunks.searchBodies[0]!['contents']).toMatchObject({
      text: { maxCharacters: expect.any(Number) },
    });

    const withoutChunks = harness([makeResult('ALPHA', 'https://example.com/a')]);
    await researchSearch(withoutChunks.exa, withoutChunks.voxell, { query: QUERY });
    expect(withoutChunks.searchBodies[0]!['contents']).toEqual({ highlights: true });
  });

  it('embeds more passages than results, and reports the count', async () => {
    const h = harness([makeLongResult('ALPHA', 'https://example.com/long')]);

    const report = await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      chunk: { maxChars: 400, overlapChars: 0 },
    });

    expect(report.stats.chunks).toBeGreaterThan(1);

    // One request for the query plus every passage. The count sent can be
    // lower than `chunks` because the client embeds repeated text once — the
    // fixture's filler paragraphs are identical, so they collapse.
    expect(h.embedBodies).toHaveLength(1);
    expect(h.embedBodies[0]!.texts[0]).toBe(QUERY);
    expect(h.embedBodies[0]!.texts.length).toBeGreaterThan(1);
    expect(h.embedBodies[0]!.texts.length).toBeLessThanOrEqual(report.stats.chunks + 1);
    expect(new Set(h.embedBodies[0]!.texts).size).toBe(h.embedBodies[0]!.texts.length);
  });

  it('leaves bestChunk unset and one vector per result when chunking is off', async () => {
    const h = harness([makeLongResult('ALPHA', 'https://example.com/long')]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.results[0]!.bestChunk).toBeUndefined();
    expect(report.results[0]!.chunkCount).toBeUndefined();
    expect(report.stats.chunks).toBe(1);
  });

  it('never sends a blank passage, which the embeddings API 502s on', async () => {
    const h = harness([
      makeLongResult('ALPHA', 'https://example.com/long'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    await researchSearch(h.exa, h.voxell, { query: QUERY, chunk: true });

    for (const text of h.embedBodies[0]!.texts) expect(text.trim()).not.toBe('');
  });
});

describe('researchSearch with clustering', () => {
  it('groups results into themes', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('BETA', 'https://other.com/beta'),
      makeResult('GAMMA', 'https://example.com/gamma'),
      makeResult('DELTA', 'https://example.com/delta'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      dedupe: false,
      cluster: { threshold: 0.9 },
    });

    expect(report.clusters).toBeDefined();
    // ALPHA/BETA are 5 degrees apart; GAMMA and DELTA are far from both.
    expect(report.clusters!.length).toBeGreaterThan(1);
    const biggest = report.clusters![0]!;
    expect(biggest.members.length).toBeGreaterThanOrEqual(2);
  });

  it('indexes cluster members into the final results array', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      cluster: true,
      dedupe: false,
    });

    for (const cluster of report.clusters!) {
      for (const member of cluster.members) {
        expect(report.results[member]).toBeDefined();
      }
      expect(cluster.members).toContain(cluster.exemplar);
    }
  });

  it('labels each cluster with its exemplar title', async () => {
    const h = harness([makeResult('ALPHA', 'https://example.com/alpha')]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY, cluster: true });

    expect(report.clusters![0]!.label).toBe('ALPHA');
  });

  it('omits clusters entirely when not requested', async () => {
    const h = harness([makeResult('ALPHA', 'https://example.com/alpha')]);

    const report = await researchSearch(h.exa, h.voxell, { query: QUERY });

    expect(report.clusters).toBeUndefined();
  });

  it('clusters only what survives dedupe and topK', async () => {
    const h = harness([
      makeResult('ALPHA', 'https://example.com/alpha'),
      makeResult('BETA', 'https://other.com/beta'),
      makeResult('GAMMA', 'https://example.com/gamma'),
    ]);

    const report = await researchSearch(h.exa, h.voxell, {
      query: QUERY,
      cluster: true,
      topK: 1,
    });

    expect(report.results).toHaveLength(1);
    expect(report.clusters!.flatMap((c) => c.members)).toEqual([0]);
  });
});
