/** In-memory vector store with oldest-first eviction. */

import type { VectorStore } from './types.js';

export interface MemoryVectorStoreOptions {
  /** Entry ceiling before oldest-first eviction. Defaults to 10000. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

export class MemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, number[]>();
  private readonly maxEntries: number;

  constructor(options: MemoryVectorStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async getMany(keys: string[]): Promise<Array<number[] | undefined>> {
    return keys.map((key) => this.entries.get(key));
  }

  async setMany(entries: Array<{ key: string; vector: number[] }>): Promise<void> {
    for (const { key, vector } of entries) {
      if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
        // Map preserves insertion order, so the first key is the oldest.
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      this.entries.set(key, vector);
    }
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async size(): Promise<number> {
    return this.entries.size;
  }
}
