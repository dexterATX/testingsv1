/**
 * Semantic clustering.
 *
 * A 25-result sweep is a list; the same 25 results grouped into five themes is
 * a map of the territory. Clustering is what turns "here are the hits" into
 * "here is what the field is arguing about".
 *
 * Uses agglomerative average-linkage: start with every item alone, repeatedly
 * merge the closest pair, stop when nothing is close enough. Average linkage
 * (rather than nearest-neighbour) prevents chaining, where A–B and B–C being
 * close drags an unrelated A and C into one cluster.
 *
 * O(n^3) worst case — fine for the tens-to-low-hundreds of results a research
 * sweep produces, not for a corpus.
 */

import { centroid, cosineSimilarity } from './similarity.js';

export interface Cluster {
  /** Indices of the member vectors. */
  members: number[];
  /** Element-wise mean of the members. */
  centroid: number[];
  /** Member closest to the centroid — the best single representative. */
  exemplar: number;
  /** Mean similarity of members to the centroid, in [-1, 1]. 1 for singletons. */
  cohesion: number;
}

export interface ClusterOptions {
  /**
   * Merge clusters whose average pairwise similarity is at or above this.
   *
   * Much lower than the dedupe threshold by design: dedupe asks "is this the
   * same story", clustering asks "is this the same topic", and two different
   * articles on one topic are not especially similar in embedding space.
   *
   * Measured against Voxell `turbo` on real article text: same-topic pairs
   * land around 0.42–0.49, cross-topic pairs at 0.22–0.33. The default sits
   * in that gap, and `test/live/pipeline.live.test.ts` asserts the gap still
   * exists.
   *
   * Note how narrow that gap is (~0.09) next to the dedupe margin. Topic
   * similarity is genuinely fuzzier than duplicate detection, so treat
   * clusters as a navigation aid rather than ground truth, and expect to tune
   * this per corpus: raise it if unrelated results are being grouped, lower it
   * if an obvious theme is fragmenting.
   */
  threshold?: number;
  /**
   * Stop merging once this many clusters remain, even if pairs still exceed
   * the threshold. Useful for a fixed-size overview.
   */
  maxClusters?: number;
}

export const DEFAULT_CLUSTER_THRESHOLD = 0.38;

/** Average pairwise similarity between two groups of vectors. */
function averageLinkage(a: number[], b: number[], similarity: number[][]): number {
  let total = 0;
  for (const i of a) {
    for (const j of b) total += (similarity[i] as number[])[j] as number;
  }
  return total / (a.length * b.length);
}

/**
 * Groups vectors into clusters, largest first.
 *
 * Ties break toward the lower index so the result is deterministic for a given
 * input order.
 */
export function clusterVectors(vectors: number[][], options: ClusterOptions = {}): Cluster[] {
  const threshold = options.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
  const maxClusters = options.maxClusters ?? 0;

  if (vectors.length === 0) return [];
  if (vectors.length === 1) {
    return [{ members: [0], centroid: [...(vectors[0] as number[])], exemplar: 0, cohesion: 1 }];
  }

  // Precompute the similarity matrix once; the merge loop reads it repeatedly.
  const similarity: number[][] = vectors.map(() => new Array<number>(vectors.length).fill(0));
  for (let i = 0; i < vectors.length; i += 1) {
    (similarity[i] as number[])[i] = 1;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const score = cosineSimilarity(vectors[i] as number[], vectors[j] as number[]);
      (similarity[i] as number[])[j] = score;
      (similarity[j] as number[])[i] = score;
    }
  }

  let groups: number[][] = vectors.map((_, index) => [index]);

  for (;;) {
    if (groups.length < 2) break;
    if (maxClusters > 0 && groups.length <= maxClusters) break;

    let bestScore = -Infinity;
    let bestA = -1;
    let bestB = -1;

    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const score = averageLinkage(groups[a] as number[], groups[b] as number[], similarity);
        if (score > bestScore) {
          bestScore = score;
          bestA = a;
          bestB = b;
        }
      }
    }

    // Below the threshold, nothing left is the same topic — unless a
    // maxClusters target still forces merges.
    const forced = maxClusters > 0 && groups.length > maxClusters;
    if (!forced && bestScore < threshold) break;
    if (bestA === -1) break;

    const merged = [...(groups[bestA] as number[]), ...(groups[bestB] as number[])].sort(
      (x, y) => x - y,
    );
    groups = groups.filter((_, index) => index !== bestA && index !== bestB);
    groups.push(merged);
  }

  const clusters = groups.map((members) => {
    const memberVectors = members.map((index) => vectors[index] as number[]);
    const center = centroid(memberVectors);

    let exemplar = members[0] as number;
    let bestScore = -Infinity;
    let total = 0;

    for (const index of members) {
      const score = cosineSimilarity(center, vectors[index] as number[]);
      total += score;
      if (score > bestScore) {
        bestScore = score;
        exemplar = index;
      }
    }

    return {
      members,
      centroid: center,
      exemplar,
      cohesion: members.length === 1 ? 1 : total / members.length,
    };
  });

  // Largest first; ties by earliest member so ordering is stable.
  clusters.sort(
    (a, b) => b.members.length - a.members.length || (a.members[0] as number) - (b.members[0] as number),
  );

  return clusters;
}
