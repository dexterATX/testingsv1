import { describe, expect, it } from 'vitest';

import { DEFAULT_CLUSTER_THRESHOLD, clusterVectors } from '../../src/research/cluster.js';

/** A unit vector at `degrees` from [1, 0], for precise similarity control. */
function atAngle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

describe('clusterVectors', () => {
  it('returns nothing for empty input', () => {
    expect(clusterVectors([])).toEqual([]);
  });

  it('returns one singleton cluster for one vector', () => {
    const clusters = clusterVectors([atAngle(0)]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ members: [0], exemplar: 0, cohesion: 1 });
  });

  it('groups similar vectors and separates dissimilar ones', () => {
    // Two tight groups 90 degrees apart.
    const clusters = clusterVectors([atAngle(0), atAngle(8), atAngle(90), atAngle(98)]);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.members.sort())).toEqual(
      expect.arrayContaining([
        [0, 1],
        [2, 3],
      ]),
    );
  });

  it('leaves everything separate when nothing clears the threshold', () => {
    const clusters = clusterVectors([atAngle(0), atAngle(60), atAngle(120)], { threshold: 0.9 });

    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it('merges everything at a permissive threshold', () => {
    const clusters = clusterVectors([atAngle(0), atAngle(30), atAngle(60)], { threshold: -1 });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toEqual([0, 1, 2]);
  });

  it('honors maxClusters even when pairs are below the threshold', () => {
    const clusters = clusterVectors([atAngle(0), atAngle(60), atAngle(120), atAngle(180)], {
      threshold: 0.99,
      maxClusters: 2,
    });

    expect(clusters).toHaveLength(2);
  });

  it('assigns every vector to exactly one cluster', () => {
    const vectors = Array.from({ length: 12 }, (_, i) => atAngle(i * 17));
    const clusters = clusterVectors(vectors, { threshold: 0.8 });

    const assigned = clusters.flatMap((c) => c.members);
    expect(new Set(assigned).size).toBe(12);
    expect(assigned).toHaveLength(12);
  });

  it('orders clusters largest first', () => {
    const clusters = clusterVectors(
      [atAngle(0), atAngle(5), atAngle(10), atAngle(90)],
      { threshold: 0.9 },
    );

    expect(clusters[0]!.members.length).toBeGreaterThanOrEqual(
      clusters.at(-1)!.members.length,
    );
    expect(clusters[0]!.members).toEqual([0, 1, 2]);
  });

  it('picks an exemplar that belongs to the cluster', () => {
    const clusters = clusterVectors([atAngle(0), atAngle(6), atAngle(12)], { threshold: 0.9 });

    for (const cluster of clusters) {
      expect(cluster.members).toContain(cluster.exemplar);
    }
  });

  it('picks the most central member as exemplar', () => {
    // The middle vector is closest to the centroid of the three.
    const clusters = clusterVectors([atAngle(0), atAngle(10), atAngle(20)], { threshold: 0.9 });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.exemplar).toBe(1);
  });

  it('reports cohesion, higher for tighter clusters', () => {
    const tight = clusterVectors([atAngle(0), atAngle(2)], { threshold: 0.5 });
    const loose = clusterVectors([atAngle(0), atAngle(50)], { threshold: 0.5 });

    expect(tight[0]!.cohesion).toBeGreaterThan(loose[0]!.cohesion);
    expect(tight[0]!.cohesion).toBeLessThanOrEqual(1);
  });

  it('uses average linkage, so a chain does not merge transitively', () => {
    // 0-1 and 1-2 each clear the bar, but 0-2 does not; average linkage must
    // not let the chain pull all three together.
    const clusters = clusterVectors([atAngle(0), atAngle(25), atAngle(50)], { threshold: 0.93 });

    expect(clusters.length).toBeGreaterThan(1);
  });

  it('is deterministic for a given input order', () => {
    const vectors = Array.from({ length: 8 }, (_, i) => atAngle(i * 23));
    const a = clusterVectors(vectors, { threshold: 0.7 });
    const b = clusterVectors(vectors, { threshold: 0.7 });

    expect(a.map((c) => c.members)).toEqual(b.map((c) => c.members));
  });

  it('defaults to a threshold below the dedupe threshold', () => {
    // Clustering asks "same topic"; dedupe asks "same story" — so the
    // clustering bar must be the looser of the two.
    expect(DEFAULT_CLUSTER_THRESHOLD).toBeLessThan(0.92);
  });
});
