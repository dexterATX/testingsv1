import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEDUPE_THRESHOLD,
  collapseNearDuplicates,
} from '../../src/research/dedupe.js';

/** A unit vector at `degrees` from [1, 0], for precise similarity control. */
function atAngle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

describe('collapseNearDuplicates', () => {
  it('keeps unrelated vectors separate', () => {
    const groups = collapseNearDuplicates([atAngle(0), atAngle(90)]);

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.duplicates.length === 0)).toBe(true);
  });

  it('absorbs vectors at or above the threshold', () => {
    // 10 degrees apart => cosine ~0.985, comfortably above the 0.92 default.
    const groups = collapseNearDuplicates([atAngle(0), atAngle(10)]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.representative).toBe(0);
    expect(groups[0]!.duplicates[0]!.index).toBe(1);
    expect(groups[0]!.duplicates[0]!.similarity).toBeCloseTo(0.9848, 3);
  });

  it('leaves vectors just below the threshold alone', () => {
    // 30 degrees => cosine ~0.866, below 0.92.
    expect(collapseNearDuplicates([atAngle(0), atAngle(30)])).toHaveLength(2);
  });

  it('treats the threshold as inclusive', () => {
    const degrees = (Math.acos(DEFAULT_DEDUPE_THRESHOLD) * 180) / Math.PI;
    const groups = collapseNearDuplicates([atAngle(0), atAngle(degrees - 1e-6)]);

    expect(groups).toHaveLength(1);
  });

  it('honors a custom threshold', () => {
    const vectors = [atAngle(0), atAngle(30)];

    expect(collapseNearDuplicates(vectors, { threshold: 0.8 })).toHaveLength(1);
    expect(collapseNearDuplicates(vectors, { threshold: 0.95 })).toHaveLength(2);
  });

  it('uses the supplied order to decide which item survives', () => {
    const vectors = [atAngle(0), atAngle(5), atAngle(90)];
    const groups = collapseNearDuplicates(vectors, { order: [1, 0, 2] });

    expect(groups[0]!.representative).toBe(1);
    expect(groups[0]!.duplicates.map((d) => d.index)).toEqual([0]);
    expect(groups[1]!.representative).toBe(2);
  });

  it('never assigns one item to two groups', () => {
    // A chain where each is close to the next but 0 and 2 are far apart.
    const vectors = [atAngle(0), atAngle(20), atAngle(40)];
    const groups = collapseNearDuplicates(vectors, { threshold: 0.9 });

    const claimed = groups.flatMap((g) => [g.representative, ...g.duplicates.map((d) => d.index)]);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toHaveLength(3);
  });

  it('compares against the representative, so a group cannot drift', () => {
    // 0-20 and 20-40 are each within threshold, but 0-40 is not: the third
    // vector must not be pulled into the first group transitively.
    const groups = collapseNearDuplicates([atAngle(0), atAngle(20), atAngle(40)], {
      threshold: 0.945, // cos(20 deg) = 0.9397 < 0.945, so nothing merges
    });

    expect(groups).toHaveLength(3);
  });

  it('handles an empty input', () => {
    expect(collapseNearDuplicates([])).toEqual([]);
  });

  it('handles a single vector', () => {
    const groups = collapseNearDuplicates([atAngle(0)]);

    expect(groups).toEqual([{ representative: 0, duplicates: [] }]);
  });
});
