/**
 * Append-only, disk-backed vector store.
 *
 * Format is JSONL, one record per line, with the vector as base64-encoded
 * float32. That is ~5x smaller than JSON numbers and survives a partially
 * written final line: a torn write costs one record, not the file.
 *
 * The whole file loads into memory on first use, so this suits a research
 * corpus (thousands of vectors), not a production vector database.
 */

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { VectorStore } from './types.js';

interface Record_ {
  k: string;
  /** base64-encoded little-endian float32 */
  v: string;
}

export interface FileVectorStoreOptions {
  /** Path to the JSONL file. Parent directories are created as needed. */
  path: string;
}

export function encodeVector(vector: number[]): string {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const buffer = Buffer.from(encoded, 'base64');
  // Copy rather than aliasing: Buffer.from(base64) may sit at a non-zero
  // offset in a pooled ArrayBuffer, which Float32Array cannot view directly.
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return Array.from(new Float32Array(copy.buffer));
}

export class FileVectorStore implements VectorStore {
  private readonly path: string;
  private cache: Map<string, number[]> | undefined;
  private loading: Promise<Map<string, number[]>> | undefined;

  constructor(options: FileVectorStoreOptions) {
    this.path = options.path;
  }

  async getMany(keys: string[]): Promise<Array<number[] | undefined>> {
    const entries = await this.load();
    return keys.map((key) => entries.get(key));
  }

  async setMany(entries: Array<{ key: string; vector: number[] }>): Promise<void> {
    if (entries.length === 0) return;

    const loaded = await this.load();
    const lines: string[] = [];

    for (const { key, vector } of entries) {
      // Skip rewriting a key we already have — the file is append-only, so a
      // duplicate would grow it without changing what reads resolve to.
      if (loaded.has(key)) continue;
      loaded.set(key, vector);
      lines.push(JSON.stringify({ k: key, v: encodeVector(vector) } satisfies Record_));
    }

    if (lines.length === 0) return;

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${lines.join('\n')}\n`, 'utf8');
  }

  async clear(): Promise<void> {
    this.cache = new Map();
    this.loading = undefined;
    await rm(this.path, { force: true });
  }

  async size(): Promise<number> {
    return (await this.load()).size;
  }

  /** Reads the file once; concurrent callers share the same load. */
  private async load(): Promise<Map<string, number[]>> {
    if (this.cache) return this.cache;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const entries = new Map<string, number[]>();

      let raw: string;
      try {
        raw = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.cache = entries;
          return entries;
        }
        throw error;
      }

      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;

        try {
          const record = JSON.parse(line) as Record_;
          if (typeof record.k === 'string' && typeof record.v === 'string') {
            entries.set(record.k, decodeVector(record.v));
          }
        } catch {
          // A torn final line from an interrupted append; skip it rather than
          // failing the whole store.
          continue;
        }
      }

      this.cache = entries;
      return entries;
    })();

    return this.loading;
  }
}
