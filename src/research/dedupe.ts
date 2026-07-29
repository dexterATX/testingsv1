/**
 * Near-duplicate collapse.
 *
 * Broad search returns the same story many times — syndicated wire copy, an
 * article and its own AMP page, a press release quoted verbatim. Embeddings
 * catch those even when the URLs and titles differ, which a string comparison
 * cannot.
 */

import { cosineSimilarity } from './similarity.js';

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
   * Calibrated against Voxell `turbo`: distinct-but-related documents land
   * near 0.65–0.75, so 0.92 collapses restatements without merging genuinely
   * different sources. Raise it if legitimate results are being absorbed.
   */
  threshold?: number;
  /**
   * Visit order — earlier indices win and become representatives. Defaults to
   * the natural order, so pass a ranked order to keep the best of each group.
   */
  order?: number[];
}

export const DEFAULT_DEDUPE_THRESHOLD = 0.92;

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
