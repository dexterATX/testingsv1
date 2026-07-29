import { describe, expect, it } from 'vitest';

import {
  centroid,
  cosineSimilarity,
  dot,
  isNormalized,
  magnitude,
  normalize,
  topK,
} from '../../src/research/similarity.js';

describe('dot', () => {
  it('computes the dot product', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('throws on a length mismatch rather than silently truncating', () => {
    expect(() => dot([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe('magnitude', () => {
  it('computes the L2 norm', () => {
    expect(magnitude([3, 4])).toBe(5);
    expect(magnitude([0, 0])).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical direction', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is -1 for opposite direction', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('agrees with dot for unit vectors, which is what Voxell returns', () => {
    const a = normalize([0.3, -0.7, 0.2]);
    const b = normalize([0.9, 0.1, -0.4]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(dot(a, b), 12);
  });
});

describe('normalize / isNormalized', () => {
  it('scales to unit length', () => {
    expect(magnitude(normalize([3, 4]))).toBeCloseTo(1, 12);
  });

  it('leaves a zero vector alone instead of dividing by zero', () => {
    expect(normalize([0, 0])).toEqual([0, 0]);
  });

  it('detects unit length within tolerance', () => {
    expect(isNormalized([1, 0])).toBe(true);
    expect(isNormalized([3, 4])).toBe(false);
  });
});

describe('centroid', () => {
  it('averages element-wise', () => {
    expect(centroid([[0, 2], [2, 4]])).toEqual([1, 3]);
  });

  it('requires at least one vector', () => {
    expect(() => centroid([])).toThrow(/at least one vector/);
  });

  it('rejects ragged input', () => {
    expect(() => centroid([[1, 2], [1]])).toThrow(/length mismatch/);
  });
});

describe('topK', () => {
  const query = [1, 0];
  const vectors = [
    [0, 1], // orthogonal
    [1, 0], // identical
    [0.7071, 0.7071], // 45 degrees
  ];

  it('returns the k most similar, highest first', () => {
    const result = topK(query, vectors, 2);

    expect(result.map((r) => r.index)).toEqual([1, 2]);
    expect(result[0]!.score).toBeCloseTo(1, 6);
  });

  it('returns everything when k exceeds the input size', () => {
    expect(topK(query, vectors, 99)).toHaveLength(3);
  });

  it('breaks ties toward the lower index, preserving upstream ranking', () => {
    const result = topK([1, 0], [[1, 0], [1, 0]], 2);

    expect(result.map((r) => r.index)).toEqual([0, 1]);
  });

  it('returns an empty list for k=0', () => {
    expect(topK(query, vectors, 0)).toEqual([]);
  });
});
