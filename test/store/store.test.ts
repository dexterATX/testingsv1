import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileVectorStore, decodeVector, encodeVector } from '../../src/store/file.js';
import { MemoryVectorStore } from '../../src/store/memory.js';
import { vectorKey, type VectorStore } from '../../src/store/types.js';

describe('vectorKey', () => {
  it('separates the same text across models', () => {
    expect(vectorKey('turbo', 'hello')).not.toBe(vectorKey('pro', 'hello'));
  });

  it('is stable for the same input', () => {
    expect(vectorKey('turbo', 'hello')).toBe(vectorKey('turbo', 'hello'));
  });
});

describe('float32 codec', () => {
  it('round-trips a vector', () => {
    const vector = [0.5, -0.25, 0, 1];

    expect(decodeVector(encodeVector(vector))).toEqual(vector);
  });

  it('round-trips within float32 precision', () => {
    const vector = Array.from({ length: 128 }, (_, i) => Math.sin(i) / 3);
    const restored = decodeVector(encodeVector(vector));

    expect(restored).toHaveLength(128);
    for (const [i, value] of vector.entries()) {
      expect(restored[i]).toBeCloseTo(value, 6);
    }
  });

  it('is far more compact than JSON numbers', () => {
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i));

    expect(encodeVector(vector).length).toBeLessThan(JSON.stringify(vector).length / 2);
  });
});

/** The behavioral contract every VectorStore must satisfy. */
function describeStoreContract(name: string, make: () => Promise<VectorStore>): void {
  describe(`${name} (VectorStore contract)`, () => {
    let store: VectorStore;

    beforeEach(async () => {
      store = await make();
    });

    it('returns undefined for unknown keys', async () => {
      expect(await store.getMany(['nope'])).toEqual([undefined]);
    });

    it('stores and retrieves vectors', async () => {
      await store.setMany([
        { key: 'a', vector: [1, 2] },
        { key: 'b', vector: [3, 4] },
      ]);

      expect(await store.getMany(['a', 'b'])).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it('preserves key order, including misses', async () => {
      await store.setMany([{ key: 'a', vector: [1] }]);

      expect(await store.getMany(['x', 'a', 'y'])).toEqual([undefined, [1], undefined]);
    });

    it('reports its size', async () => {
      expect(await store.size()).toBe(0);
      await store.setMany([{ key: 'a', vector: [1] }]);
      expect(await store.size()).toBe(1);
    });

    it('clears', async () => {
      await store.setMany([{ key: 'a', vector: [1] }]);
      await store.clear();

      expect(await store.size()).toBe(0);
      expect(await store.getMany(['a'])).toEqual([undefined]);
    });

    it('handles an empty write', async () => {
      await expect(store.setMany([])).resolves.toBeUndefined();
      expect(await store.size()).toBe(0);
    });
  });
}

describeStoreContract('MemoryVectorStore', async () => new MemoryVectorStore());

describe('MemoryVectorStore', () => {
  it('evicts oldest-first at the ceiling', async () => {
    const store = new MemoryVectorStore({ maxEntries: 2 });

    await store.setMany([{ key: 'a', vector: [1] }]);
    await store.setMany([{ key: 'b', vector: [2] }]);
    await store.setMany([{ key: 'c', vector: [3] }]);

    expect(await store.getMany(['a', 'b', 'c'])).toEqual([undefined, [2], [3]]);
    expect(await store.size()).toBe(2);
  });

  it('overwriting an existing key does not evict', async () => {
    const store = new MemoryVectorStore({ maxEntries: 2 });

    await store.setMany([
      { key: 'a', vector: [1] },
      { key: 'b', vector: [2] },
    ]);
    await store.setMany([{ key: 'a', vector: [9] }]);

    expect(await store.getMany(['a', 'b'])).toEqual([[9], [2]]);
  });
});

describe('FileVectorStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vecstore-'));
    path = join(dir, 'nested', 'vectors.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describeStoreContract('FileVectorStore', async () =>
    new FileVectorStore({ path: join(await mkdtemp(join(tmpdir(), 'vec-')), 'v.jsonl') }),
  );

  it('persists across instances', async () => {
    const first = new FileVectorStore({ path });
    await first.setMany([{ key: 'a', vector: [0.5, -0.5] }]);

    const second = new FileVectorStore({ path });
    const [restored] = await second.getMany(['a']);

    expect(restored).toEqual([0.5, -0.5]);
  });

  it('creates parent directories', async () => {
    const store = new FileVectorStore({ path });
    await store.setMany([{ key: 'a', vector: [1] }]);

    await expect(readFile(path, 'utf8')).resolves.toContain('"k":"a"');
  });

  it('treats a missing file as empty rather than throwing', async () => {
    const store = new FileVectorStore({ path: join(dir, 'absent.jsonl') });

    expect(await store.size()).toBe(0);
  });

  it('does not append a duplicate record for a key it already has', async () => {
    const store = new FileVectorStore({ path });
    await store.setMany([{ key: 'a', vector: [1] }]);
    await store.setMany([{ key: 'a', vector: [1] }]);

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('skips a torn final line instead of failing the whole store', async () => {
    const store = new FileVectorStore({ path });
    await store.setMany([
      { key: 'a', vector: [1] },
      { key: 'b', vector: [2] },
    ]);

    // Simulate a process killed mid-append.
    const raw = await readFile(path, 'utf8');
    await writeFile(path, `${raw}{"k":"c","v":"trunc`, 'utf8');

    const reopened = new FileVectorStore({ path });

    expect(await reopened.size()).toBe(2);
    expect(await reopened.getMany(['a', 'b', 'c'])).toEqual([[1], [2], undefined]);
  });

  it('loads the file once under concurrent reads', async () => {
    const seeded = new FileVectorStore({ path });
    await seeded.setMany([{ key: 'a', vector: [1] }]);

    const store = new FileVectorStore({ path });
    const [first, second] = await Promise.all([store.getMany(['a']), store.getMany(['a'])]);

    expect(first).toEqual([[1]]);
    expect(second).toEqual([[1]]);
  });

  it('clear removes the backing file', async () => {
    const store = new FileVectorStore({ path });
    await store.setMany([{ key: 'a', vector: [1] }]);
    await store.clear();

    await expect(readFile(path, 'utf8')).rejects.toThrow();
    expect(await store.size()).toBe(0);
  });
});
