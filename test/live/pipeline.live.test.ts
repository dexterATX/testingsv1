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
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ExaClient } from '../../src/exa/client.js';
import { VoxellClient } from '../../src/voxell/client.js';
import { thresholdsFor } from '../../src/research/thresholds.js';
import { researchSearch } from '../../src/research/pipeline.js';
import { cosineSimilarity } from '../../src/research/similarity.js';
import { resultToEmbedText } from '../../src/research/text.js';
import { FileVectorStore } from '../../src/store/file.js';
import { synthesize } from '../../src/synthesis/synthesize.js';
import type { Completer } from '../../src/synthesis/types.js';
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

  it('brackets the dedupe threshold with a restatement and a distinct topic', async () => {
    // The calibration the default rests on. If Voxell changes the model behind
    // an alias, this is the test that should fail first.
    //
    // Asserted against `thresholdsFor(voxell.model)` rather than a literal,
    // because the right number moves with the model — hard-coding one here is
    // exactly how the old 0.92 outlived the measurement it came from.
    const { dedupe: threshold } = thresholdsFor(voxell.model);

    const { embeddings } = await voxell.embed([
      `${FIXTURES[1]!.title} ${FIXTURES[1]!.highlights!.join(' ')}`,
      `${FIXTURES[2]!.title} ${FIXTURES[2]!.highlights!.join(' ')}`,
      `${FIXTURES[3]!.title} ${FIXTURES[3]!.highlights!.join(' ')}`,
    ]);

    const restatement = cosineSimilarity(embeddings[0]!, embeddings[1]!);
    const distinctButRelated = cosineSimilarity(embeddings[0]!, embeddings[2]!);

    expect(restatement).toBeGreaterThan(threshold);
    expect(distinctButRelated).toBeLessThan(threshold);
  });

  it('only ever collapses pairs well inside the duplicate band', async () => {
    // The regression that motivated per-model thresholds: at 0.92, distinct
    // articles that merely shared a topic were being absorbed into each other.
    // Exa is stubbed here, so this guards the rule rather than rediscovering
    // it — nothing may be collapsed at a similarity that a real same-topic
    // pair could reach (measured ceiling 0.948 on turbo, 0.908 on ultra-4k).
    const report = await researchSearch(exa, voxell, { query: QUERY });

    const collapsed = report.results.flatMap((r) =>
      r.duplicates.map((d) => ({ kept: r.result.url, dropped: d.result.url, sim: d.similarity })),
    );

    expect(collapsed.length).toBeGreaterThan(0);
    for (const c of collapsed) {
      expect(
        c.sim,
        `collapsed ${c.dropped} into ${c.kept} at ${c.sim.toFixed(3)}`,
      ).toBeGreaterThan(0.95);
    }
  });

  it('reports coherent stats on a cold cache', async () => {
    // A fresh client, so this measures real API usage rather than cache hits.
    const cold = new VoxellClient({ maxRetries: 1 });
    const report = await researchSearch(exa, cold, { query: QUERY });

    expect(report.stats).toMatchObject({
      retrieved: 4,
      exactDuplicates: 0,
      embedded: 5,
      dim: VoxellClient.dimensionsFor(cold.model),
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

/** A long page where a single passage is on-topic and the rest is not. */
const BURIED: ExaResult = {
  id: 'buried',
  url: 'https://example.com/buried',
  title: 'Engineering blog: infrastructure notes',
  highlights: ['Assorted notes from the platform team.'],
  text: [
    'Our Kubernetes upgrade went smoothly this quarter. We moved from 1.28 to 1.30 across all clusters, and the rollout took three weeks with no customer-visible downtime. The node pools were drained one at a time.',
    'We also migrated the CI runners to a new instance family, which cut build times by roughly eighteen percent. Cache hit rates improved after we moved the layer cache to local NVMe.',
    'On retrieval quality: we now maintain a golden dataset of question and passage pairs, and we measure recall at k and mean reciprocal rank on every change to the RAG retrieval stage. Regressions block the deploy.',
    'The office move is scheduled for next month. Desks will be assigned by team, and the new space has more meeting rooms.',
    'Finally, we upgraded Postgres to 16 and enabled logical replication for the analytics read replica.',
  ].join('\n\n'),
};

const OFF_TOPIC_PAIR: ExaResult[] = [
  {
    id: 'k8s-1',
    url: 'https://example.com/k8s-networking',
    title: 'Debugging Kubernetes pod networking',
    highlights: [
      'CNI plugin misconfiguration is the most common cause of pods failing to reach each other across nodes.',
    ],
  },
  {
    id: 'k8s-2',
    url: 'https://example.com/service-mesh',
    title: 'Service mesh sidecar resource tuning',
    highlights: [
      'Envoy sidecars default to generous CPU limits; tuning them down reclaims significant cluster capacity.',
    ],
  },
];

describe.skipIf(!enabled)('chunking against live Voxell', () => {
  it('finds the one relevant passage buried in an off-topic page', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ requestId: 'r', results: [BURIED] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const buriedExa = new ExaClient({ apiKey: 'stub', baseUrl: `http://127.0.0.1:${port}` });

    try {
      const chunked = await researchSearch(buriedExa, voxell, {
        query: QUERY,
        chunk: { maxChars: 400, overlapChars: 0 },
      });
      const whole = await researchSearch(buriedExa, voxell, { query: QUERY });

      const best = chunked.results[0]!.bestChunk!;

      // The winning passage is the retrieval-quality paragraph, not the
      // Kubernetes or office-move ones.
      expect(best.text).toMatch(/recall at k|golden dataset/i);
      expect(chunked.results[0]!.chunkCount).toBeGreaterThan(1);

      // And scoring the best passage beats averaging the whole page — the
      // entire reason chunking exists.
      expect(chunked.results[0]!.score).toBeGreaterThan(whole.results[0]!.score);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

/**
 * These fixtures span two unrelated topics, so their same-topic pairs land far
 * lower than a real single-query result set's. The default targets the latter.
 */
const FIXTURE_CLUSTER_THRESHOLD = 0.415;

describe.skipIf(!enabled)('clustering against live Voxell', () => {
  it('separates two genuinely different topics', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: 'r',
            results: [FIXTURES[1], FIXTURES[3], ...OFF_TOPIC_PAIR],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const mixedExa = new ExaClient({ apiKey: 'stub', baseUrl: `http://127.0.0.1:${port}` });

    try {
      // An explicit threshold, because these fixtures are deliberately more
      // diverse than anything one Exa query returns: two topics that share
      // nothing, where same-topic pairs sit near 0.42 and cross-topic at 0.41. Real single-query
      // results all sit above 0.65, which is the regime the per-model default
      // targets. No constant serves both — see src/research/thresholds.ts.
      const report = await researchSearch(mixedExa, voxell, {
        query: 'retrieval quality and infrastructure operations',
        cluster: { threshold: FIXTURE_CLUSTER_THRESHOLD },
        dedupe: false,
      });

      expect(report.clusters).toBeDefined();
      expect(report.clusters!.length).toBeGreaterThanOrEqual(2);

      // The two Kubernetes pages belong together, and apart from the RAG ones.
      const clusterOf = (needle: string): number =>
        report.clusters!.findIndex((c) =>
          c.members.some((m) => report.results[m]!.result.url.includes(needle)),
        );

      expect(clusterOf('k8s-networking')).toBe(clusterOf('service-mesh'));
      expect(clusterOf('rag-eval')).not.toBe(clusterOf('k8s-networking'));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('leaves a usable gap between same-topic and cross-topic pairs', async () => {
    // The invariant that makes clustering possible at all: a gap exists. What
    // it does *not* establish is a single constant that finds it, because
    // where the gap sits moves with the input — these fixtures put it near
    // 0.5, a real single-query result set puts it above 0.8.
    // Embedded through `resultToEmbedText`, the same function the pipeline
    // uses. Composing the text by hand here instead put same-topic pairs at
    // 0.513 while the pipeline saw 0.424 for the very same documents, and a
    // threshold picked from the first number does not work in the second.
    // Measuring anything other than what the pipeline actually embeds is how
    // both of this file's thresholds went stale before.
    const { embeddings } = await voxell.embed([
      resultToEmbedText(FIXTURES[1]!),
      resultToEmbedText(FIXTURES[3]!),
      resultToEmbedText(OFF_TOPIC_PAIR[0]!),
      resultToEmbedText(OFF_TOPIC_PAIR[1]!),
    ]);

    const sameTopic = [
      cosineSimilarity(embeddings[0]!, embeddings[1]!),
      cosineSimilarity(embeddings[2]!, embeddings[3]!),
    ];
    const crossTopic = [
      cosineSimilarity(embeddings[0]!, embeddings[2]!),
      cosineSimilarity(embeddings[0]!, embeddings[3]!),
      cosineSimilarity(embeddings[1]!, embeddings[2]!),
      cosineSimilarity(embeddings[1]!, embeddings[3]!),
    ];

    // A real gap, and the fixture threshold sits inside it.
    expect(Math.min(...sameTopic)).toBeGreaterThan(Math.max(...crossTopic));
    expect(Math.min(...sameTopic)).toBeGreaterThan(FIXTURE_CLUSTER_THRESHOLD);
    expect(Math.max(...crossTopic)).toBeLessThan(FIXTURE_CLUSTER_THRESHOLD);

    // The gap is real but narrow — 0.406 to 0.424 as measured. That thinness
    // is the point: it is why no constant serves every input, and why the
    // per-model default (tuned for one query's worth of results, which pair
    // far higher) sits well above this one.
    expect(thresholdsFor(voxell.model).cluster).toBeGreaterThan(Math.min(...sameTopic));
  });
});

describe.skipIf(!enabled)('full pipeline into synthesis, with live Voxell', () => {
  it('feeds real ranked results into synthesis and validates the citations', async () => {
    const report = await researchSearch(exa, voxell, { query: QUERY, cluster: true, topK: 3 });

    // The completer is stubbed (no Anthropic key needed) but everything
    // upstream of it is real: real embeddings, real ranking, real dedupe.
    const seen: { system: string; prompt: string }[] = [];
    const completer: Completer = async (request) => {
      seen.push({ system: request.system, prompt: request.prompt });
      // Cite the first two real sources, plus one that does not exist.
      return { text: 'Grounded claim [1] and another [2]. A fabricated one [99].' };
    };

    const synthesis = await synthesize(report, { completer });

    // The prompt carried the actual retrieved URLs, not placeholders.
    for (const entry of report.results) {
      expect(seen[0]!.prompt).toContain(entry.result.url);
    }

    expect(synthesis.sources).toHaveLength(report.results.length);
    expect(synthesis.sources[0]!.cited).toBe(true);
    expect(synthesis.invalidMarkers).toEqual([99]);
    expect(synthesis.uncitedMarkers).toEqual([3]);
  });

  it('persists real embeddings to disk and reuses them on a second run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-live-'));
    const path = join(dir, 'vectors.jsonl');

    try {
      const first = new VoxellClient({ store: new FileVectorStore({ path }), maxRetries: 1 });
      const cold = await researchSearch(exa, first, { query: QUERY });
      expect(cold.stats.tokens).toBeGreaterThan(0);

      // A different client and store instance, same file.
      const second = new VoxellClient({ store: new FileVectorStore({ path }), maxRetries: 1 });
      const warm = await researchSearch(exa, second, { query: QUERY });

      expect(warm.stats.tokens).toBe(0);
      expect(warm.stats.cacheHits).toBe(cold.stats.chunks + 1);
      // Ranking must survive the float32 round trip.
      expect(warm.results.map((r) => r.result.url)).toEqual(
        cold.results.map((r) => r.result.url),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
