/**
 * Near-duplicate collapse.
 *
 * Broad search returns the same story many times — syndicated wire copy, an
 * article and its own AMP page, a press release quoted verbatim. Embeddings
 * catch those even when the URLs and titles differ, which a string comparison
 * cannot.
 */

import { cosineSimilarity } from './similarity.js';
import { UNMEASURED_THRESHOLDS } from './thresholds.js';

export interface DuplicateOf {
  index: number;
  similarity: number;
}

export interface DuplicateGroup {
  /** Index of the kept item. */
  representative: number;
  /** Indices collapsed into it, with their similarity to the representative. */
  duplicates: DuplicateOf[];
}

export interface DedupeOptions {
  /**
   * Cosine similarity at or above which two items are the same story.
   *
   * The right value depends on which embedding model produced the vectors —
   * see `./thresholds.ts`. Callers that know their model should pass
   * `thresholdsFor(model).dedupe`; the default here is the conservative
   * fallback, because this function cannot see where its vectors came from.
   */
  threshold?: number;
  /**
   * Visit order — earlier indices win and become representatives. Defaults to
   * the natural order, so pass a ranked order to keep the best of each group.
   */
  order?: number[];
}

/**
 * Fallback for callers that do not name a model. Intentionally strict: over-
 * collapsing destroys results the user came for, under-collapsing repeats one.
 */
export const DEFAULT_DEDUPE_THRESHOLD = UNMEASURED_THRESHOLDS.dedupe;

/**
 * Greedily groups vectors into near-duplicate clusters.
 *
 * Each unclaimed item in `order` becomes a representative and absorbs every
 * later unclaimed item within `threshold` of it. Comparison is against the
 * representative rather than the running centroid, so one cluster cannot drift
 * away from the document that opened it.
 */
export function collapseNearDuplicates(
  vectors: number[][],
  options: DedupeOptions = {},
): DuplicateGroup[] {
  const threshold = options.threshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const order = options.order ?? vectors.map((_, index) => index);

  const claimed = new Set<number>();
  const groups: DuplicateGroup[] = [];

  for (const index of order) {
    if (claimed.has(index)) continue;

    claimed.add(index);
    const group: DuplicateGroup = { representative: index, duplicates: [] };
    const representative = vectors[index];
    if (!representative) continue;

    for (const candidate of order) {
      if (candidate === index || claimed.has(candidate)) continue;

      const vector = vectors[candidate];
      if (!vector) continue;

      const similarity = cosineSimilarity(representative, vector);
      if (similarity >= threshold) {
        claimed.add(candidate);
        group.duplicates.push({ index: candidate, similarity });
      }
    }

    groups.push(group);
  }

  return groups;
}
