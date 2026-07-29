/**
 * The Exa → Voxell pipeline end to end, using real embeddings.
 *
 * Exa is stubbed with a localhost server (fixtures give repeatable content);
 * Voxell is the live API, because the whole point of the second pass is
 * whether real embeddings actually separate these documents.
 *
 *   VOXELL_LIVE_TEST=1 npm run test:live
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ExaClient } from '../../src/exa/client.js';
import { VoxellClient } from '../../src/voxell/client.js';
import { researchSearch } from '../../src/research/pipeline.js';
import { cosineSimilarity } from '../../src/research/similarity.js';
import type { ExaResult } from '../../src/exa/types.js';

vi.setConfig({ testTimeout: 60_000 });

const enabled = process.env['VOXELL_LIVE_TEST'] === '1' && Boolean(process.env['VOXELL_API_KEY']);

const QUERY = 'how are engineering teams evaluating retrieval quality in RAG systems?';

/**
 * Two of these are the same story told twice — the wire-copy case dedupe is
 * meant to catch. The others are on-topic-but-distinct and clearly off-topic.
 */
const FIXTURES: ExaResult[] = [
  {
    id: '1',
    url: 'https://example.com/off-topic',
    title: 'A beginner guide to sourdough starter maintenance',
    highlights: [
      'Feed the starter twice daily with equal parts flour and water until it doubles reliably.',
      'A mature starter smells tangy and yeasty rather than sharply acidic.',
    ],
  },
  {
    id: '2',
    url: 'https://newswire-a.com/rag-eval',
    title: 'Teams turn to golden datasets to measure RAG retrieval quality',
    highlights: [
      'Engineering teams are increasingly building curated golden datasets of question and passage pairs to measure whether their retrieval step surfaces the right documents.',
      'Recall at k and mean reciprocal rank remain the most widely reported retrieval metrics in production RAG deployments.',
    ],
  },
  {
    id: '3',
    url: 'https://newswire-b.com/rag-eval-reprint',
    title: 'Golden datasets become the standard for measuring RAG retrieval quality',
    highlights: [
      'Engineering organisations are more and more assembling curated golden datasets of question and passage pairs in order to measure whether the retrieval stage returns the correct documents.',
      'Recall at k and mean reciprocal rank continue to be the most commonly reported retrieval metrics in production RAG systems.',
    ],
  },
  {
    id: '4',
    url: 'https://example.com/chunking',
    title: 'Chunking strategies and their effect on embedding quality',
    highlights: [
      'Splitting documents on semantic boundaries rather than fixed token counts measurably improves downstream answer quality.',
      'Overlapping windows help preserve context that would otherwise be severed at a chunk boundary.',
    ],
  },
];

let server: http.Server;
let exa: ExaClient;
let voxell: VoxellClient;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: 'req_live', searchType: 'auto', results: FIXTURES }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  exa = new ExaClient({ apiKey: 'stub', baseUrl: `http://127.0.0.1:${port}` });
  voxell = new VoxellClient({ maxRetries: 1 });
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe.skipIf(!enabled)('research pipeline against live Voxell', () => {
  it('ranks on-topic results above off-topic ones', async () => {
    const report = await researchSearch(exa, voxell, { query: QUERY, dedupe: false });

    const titles = report.results.map((r) => r.result.title);
    const sourdoughRank = titles.findIndex((t) => t?.includes('sourdough'));

    expect(sourdoughRank).toBe(report.results.length - 1);
    expect(report.results[0]!.score).toBeGreaterThan(report.results.at(-1)!.score + 0.2);
  });

  it('promotes the best match over Exa’s original ordering', async () => {
    // The fixture list deliberately puts the off-topic result first.
    const report = await researchSearch(exa, voxell, { query: QUERY, dedupe: false });

    expect(report.results[0]!.originalRank).not.toBe(0);
    expect(report.results[0]!.rankDelta).toBeGreaterThan(0);
  });

  it('collapses the two retellings of the same story', async () => {
    const report = await researchSearch(exa, voxell, { query: QUERY });

    const urls = report.results.map((r) => r.result.url);
    const kept = urls.filter((u) => u.includes('newswire'));

    expect(kept).toHaveLength(1);
    expect(report.stats.nearDuplicates).toBe(1);

    const collapsed = report.results.find((r) => r.duplicates.length > 0);
    expect(collapsed?.duplicates[0]!.result.url).toContain('newswire');
  });

  it('keeps genuinely distinct on-topic results apart', async () => {
    const report = await researchSearch(exa, voxell, { query: QUERY });

    const urls = report.results.map((r) => r.result.url);
    expect(urls).toContain('https://example.com/chunking');
    expect(urls).toContain('https://example.com/off-topic');
  });

  it('places the default 0.92 threshold between restatement and distinct topics', async () => {
    // The calibration the default rests on. If Voxell changes models this is
    // the test that should fail first.
    const { embeddings } = await voxell.embed([
      `${FIXTURES[1]!.title} ${FIXTURES[1]!.highlights!.join(' ')}`,
      `${FIXTURES[2]!.title} ${FIXTURES[2]!.highlights!.join(' ')}`,
      `${FIXTURES[3]!.title} ${FIXTURES[3]!.highlights!.join(' ')}`,
    ]);

    const restatement = cosineSimilarity(embeddings[0]!, embeddings[1]!);
    const distinctButRelated = cosineSimilarity(embeddings[0]!, embeddings[2]!);

    expect(restatement).toBeGreaterThan(0.92);
    expect(distinctButRelated).toBeLessThan(0.92);
  });

  it('reports coherent stats on a cold cache', async () => {
    // A fresh client, so this measures real API usage rather than cache hits.
    const cold = new VoxellClient({ maxRetries: 1 });
    const report = await researchSearch(exa, cold, { query: QUERY });

    expect(report.stats).toMatchObject({
      retrieved: 4,
      exactDuplicates: 0,
      embedded: 5,
      dim: 1024,
      cacheHits: 0,
    });
    expect(report.stats.tokens).toBeGreaterThan(0);
    expect(report.results.length + report.stats.nearDuplicates).toBe(4);
  });

  it('spends no tokens on a repeat run with a warm cache', async () => {
    const warm = new VoxellClient({ maxRetries: 1 });

    const first = await researchSearch(exa, warm, { query: QUERY });
    const second = await researchSearch(exa, warm, { query: QUERY });

    expect(first.stats.tokens).toBeGreaterThan(0);
    expect(second.stats.tokens).toBe(0);
    expect(second.stats.cacheHits).toBe(5);
    // Same ranking either way — the cache must not change the outcome.
    expect(second.results.map((r) => r.result.url)).toEqual(
      first.results.map((r) => r.result.url),
    );
  });

  it('honors topK and minScore', async () => {
    const report = await researchSearch(exa, voxell, { query: QUERY, topK: 2 });
    expect(report.results).toHaveLength(2);

    const filtered = await researchSearch(exa, voxell, { query: QUERY, minScore: 0.99 });
    expect(filtered.results.length).toBeLessThan(report.results.length);
  });
});
