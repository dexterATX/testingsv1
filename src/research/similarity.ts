/**
 * Vector similarity primitives.
 *
 * Voxell returns unit-length vectors, so for its output `dot` and
 * `cosineSimilarity` agree and `dot` is the cheaper of the two. The pipeline
 * uses `cosineSimilarity` anyway, since it stays correct if vectors ever
 * arrive un-normalized (a different model, a different provider, a cached
 * corpus built elsewhere).
 */

/** Dot product. Equal to cosine similarity when both vectors are unit-length. */
export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}.`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function magnitude(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 if either vector is all zeros,
 * rather than NaN.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const product = dot(a, b);
  const scale = magnitude(a) * magnitude(b);
  return scale === 0 ? 0 : product / scale;
}

/** True if the vector is unit-length within `tolerance`. */
export function isNormalized(vector: number[], tolerance = 1e-4): boolean {
  return Math.abs(magnitude(vector) - 1) <= tolerance;
}

/** Returns a unit-length copy. A zero vector is returned unchanged. */
export function normalize(vector: number[]): number[] {
  const scale = magnitude(vector);
  return scale === 0 ? [...vector] : vector.map((value) => value / scale);
}

/** The element-wise mean of a set of vectors — a cheap cluster centroid. */
export function centroid(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) throw new Error('centroid requires at least one vector.');

  const result = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    if (vector.length !== first.length) {
      throw new Error(`Vector length mismatch: ${vector.length} vs ${first.length}.`);
    }
    for (let i = 0; i < vector.length; i += 1) {
      result[i] = (result[i] as number) + (vector[i] as number);
    }
  }

  return result.map((value) => value / vectors.length);
}

export interface ScoredIndex {
  index: number;
  score: number;
}

/**
 * The `k` vectors most similar to `query`, highest first.
 *
 * Ties break toward the lower index, so an upstream ranking survives as the
 * tiebreaker.
 */
export function topK(query: number[], vectors: number[][], k: number): ScoredIndex[] {
  const scored = vectors.map((vector, index) => ({
    index,
    score: cosineSimilarity(query, vector),
  }));

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return k >= 0 ? scored.slice(0, k) : scored;
}
