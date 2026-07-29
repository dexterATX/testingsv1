/**
 * Live tests against the real Voxell API.
 *
 * Opt-in: these are skipped unless `VOXELL_LIVE_TEST=1` and `VOXELL_API_KEY`
 * are both set, so a normal `npm test` never spends tokens or needs network.
 *
 *   VOXELL_LIVE_TEST=1 npm run test:live
 *
 * They exist because Voxell publishes no reference docs — every limit and
 * shape the client encodes was measured, and only a live run proves those
 * measurements still hold.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { VoxellClient } from '../../src/voxell/client.js';
import { cosineSimilarity, isNormalized } from '../../src/research/similarity.js';
import { FileVectorStore } from '../../src/store/file.js';

// Real network plus a 32000-character embed does not fit in the 5s default.
vi.setConfig({ testTimeout: 60_000 });

const enabled = process.env['VOXELL_LIVE_TEST'] === '1' && Boolean(process.env['VOXELL_API_KEY']);

describe.skipIf(!enabled)('Voxell live API', () => {
  const client = (): VoxellClient => new VoxellClient({ maxRetries: 1 });

  it('embeds a single text and returns a unit vector of the documented size', async () => {
    const result = await client().embed(['semantic search relevance'], { model: 'turbo' });

    expect(result.embeddings).toHaveLength(1);
    // This call names `turbo` explicitly, so 1024 is the right literal here.
    expect(result.dim).toBe(1024);
    expect(result.embeddings[0]).toHaveLength(1024);
    expect(isNormalized(result.embeddings[0]!)).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it.each([
    ['turbo', 1024],
    ['pro', 2560],
    ['ultra-4k', 4096],
  ] as const)('returns %s at %i dimensions', async (model, dim) => {
    const result = await client().embed(['dimension check'], { model });

    expect(result.dim).toBe(dim);
    expect(result.embeddings[0]).toHaveLength(dim);
    expect(VoxellClient.dimensionsFor(model)).toBe(dim);
  });

  it('returns a bit-identical vector for an identical request', async () => {
    const first = await client().embed(['determinism probe']);
    const second = await client().embed(['determinism probe']);

    expect(second.embeddings[0]).toEqual(first.embeddings[0]);
  });

  it('varies only negligibly when the same text is sent in a different batch shape', async () => {
    // Batched inference selects kernels by padded tensor shape, so the same
    // text in a different-sized batch can differ in the 4th decimal place.
    // This pins the size of that drift: it must stay far below any threshold.
    const alone = await client().embedOne('batch shape probe');
    const inBatch = await client().embed([
      'batch shape probe',
      ...Array.from({ length: 15 }, (_, i) => `filler ${i}`),
    ]);

    const drift = Math.max(
      ...alone.map((value, i) => Math.abs(value - (inBatch.embeddings[0]![i] as number))),
    );

    expect(cosineSimilarity(alone, inBatch.embeddings[0]!)).toBeGreaterThan(0.9999);
    expect(drift).toBeLessThan(0.01);
  });

  it('separates related from unrelated text by a wide margin', async () => {
    const { embeddings } = await client().embed([
      'vector databases for retrieval augmented generation',
      'approximate nearest neighbor search over embeddings',
      'sourdough bread baking techniques',
    ]);

    const related = cosineSimilarity(embeddings[0]!, embeddings[1]!);
    const unrelated = cosineSimilarity(embeddings[0]!, embeddings[2]!);

    expect(related).toBeGreaterThan(unrelated + 0.2);
  });

  it('batches a large input and preserves order', async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `research document number ${i}`);
    const batched = await new VoxellClient({ batchSize: 16 }).embed(texts);

    expect(batched.batches).toBe(3);
    expect(batched.embeddings).toHaveLength(40);

    // Order is what matters: slot 37 must be the vector for document 37, not
    // whatever landed there. Compared by similarity rather than equality,
    // because batch shape shifts the low-order bits (see the drift test).
    const single = await client().embedOne('research document number 37');

    expect(cosineSimilarity(single, batched.embeddings[37]!)).toBeGreaterThan(0.9999);
    expect(cosineSimilarity(single, batched.embeddings[36]!)).toBeLessThan(0.99);
  });

  it('serves a repeat call from cache', async () => {
    const shared = client();
    await shared.embed(['cache probe']);
    const second = await shared.embed(['cache probe']);

    expect(second.cacheHits).toBe(1);
    expect(second.batches).toBe(0);
  });

  it('rejects oversized text locally rather than taking a 413', async () => {
    await expect(client().embed(['x'.repeat(32_001)])).rejects.toThrow(/413/);
  });

  it('truncates oversized text when configured to, and the API accepts it', async () => {
    const truncating = new VoxellClient({ onOversizedText: 'truncate', maxRetries: 1 });
    const result = await truncating.embed(['long input '.repeat(5_000)]);

    // Derived from the client's model, not hard-coded: the default tier moved
    // from 1024d turbo to 4096d ultra-4k and a literal here silently rotted.
    // Derived from the model rather than hard-coded: the default tier moved
    // from 1024d turbo to 4096d ultra-4k, and a literal here silently rotted.
    expect(result.embeddings[0]).toHaveLength(VoxellClient.dimensionsFor(truncating.model)!);
  });

  it('accepts input right at the 32000-character ceiling', async () => {
    // Confirms the measured limit is exact: one char more is a 413, and the
    // client's guard is calibrated to the right boundary.
    const atLimit = new VoxellClient({ maxRetries: 0 });

    await expect(atLimit.embed(['z'.repeat(32_000)])).resolves.toBeDefined();
  });

  it('lists the models this key can use', async () => {
    const { data } = await client().models();

    expect(data.map((m) => m.id)).toContain('forge-turbo');
  });
});

describe.skipIf(!enabled)('FileVectorStore with live Voxell', () => {
  it('persists real vectors across client instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voxell-live-'));
    const path = join(dir, 'vectors.jsonl');

    try {
      const first = new VoxellClient({ store: new FileVectorStore({ path }), maxRetries: 1 });
      const cold = await first.embed(['persistence probe one', 'persistence probe two']);

      expect(cold.cacheHits).toBe(0);
      expect(cold.tokens).toBeGreaterThan(0);

      // A brand-new client and a brand-new store, reading the same file.
      const second = new VoxellClient({ store: new FileVectorStore({ path }), maxRetries: 1 });
      const warm = await second.embed(['persistence probe one', 'persistence probe two']);

      expect(warm.cacheHits).toBe(2);
      expect(warm.batches).toBe(0);
      expect(warm.tokens).toBe(0);

      // Float32 storage is lossy relative to the API's float64 JSON, so
      // compare by similarity rather than equality — the drift must be far
      // below anything the ranking thresholds care about.
      expect(cosineSimilarity(cold.embeddings[0]!, warm.embeddings[0]!)).toBeGreaterThan(0.9999);
      expect(warm.embeddings[0]).toHaveLength(VoxellClient.dimensionsFor(second.model)!);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
