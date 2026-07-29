import { describe, expect, it } from 'vitest';

import { isCalibrated, thresholdsFor } from '../../src/research/thresholds.js';
import { DEFAULT_EMBED_MODEL, MODEL_DIMENSIONS } from '../../src/voxell/types.js';

describe('thresholdsFor', () => {
  it('gives the default model measured thresholds rather than the fallback', () => {
    // If the default ever moves to an unmeasured model, the pipeline silently
    // starts deduping on a guess. That is the failure this guards.
    expect(isCalibrated(DEFAULT_EMBED_MODEL)).toBe(true);
  });

  it('separates ultra-4k from turbo, because their similarity scales differ', () => {
    expect(thresholdsFor('ultra-4k')).not.toEqual(thresholdsFor('turbo'));
  });

  it('keeps every dedupe threshold above the measured non-duplicate ceiling', () => {
    // Measured maxima for pairs that are *not* the same story: 0.948 (turbo),
    // 0.908 (ultra-4k). A threshold at or below those collapses distinct
    // articles that merely share a topic — the bug the old 0.92 default had.
    expect(thresholdsFor('turbo').dedupe).toBeGreaterThan(0.948);
    expect(thresholdsFor('ultra-4k').dedupe).toBeGreaterThan(0.908);
  });

  it('keeps every dedupe threshold below the measured duplicate floor', () => {
    // True same-story pairs scored 0.986 (turbo) and 0.980 (ultra-4k).
    expect(thresholdsFor('turbo').dedupe).toBeLessThan(0.986);
    expect(thresholdsFor('ultra-4k').dedupe).toBeLessThan(0.98);
  });

  it('treats an OpenAI-compatible alias as the model it actually maps to', () => {
    // forge-ultra-4k and ultra-4k are the same vectors at the same dimensions,
    // so they must not get different thresholds.
    expect(MODEL_DIMENSIONS['forge-ultra-4k']).toBe(MODEL_DIMENSIONS['ultra-4k']);
    expect(thresholdsFor('forge-ultra-4k')).toEqual(thresholdsFor('ultra-4k'));
    expect(thresholdsFor('forge-turbo')).toEqual(thresholdsFor('turbo'));
  });

  it('falls back conservatively for a model nobody has measured', () => {
    expect(isCalibrated('pro')).toBe(false);
    expect(isCalibrated('some-future-model')).toBe(false);

    // Strict rather than permissive: over-collapsing destroys results, while
    // under-collapsing only repeats one.
    expect(thresholdsFor('pro').dedupe).toBeGreaterThanOrEqual(0.95);
    expect(thresholdsFor(undefined).dedupe).toBeGreaterThanOrEqual(0.95);
  });

  it('puts cluster below dedupe for every model', () => {
    for (const model of ['turbo', 'ultra-4k', 'pro', undefined]) {
      const t = thresholdsFor(model);
      expect(t.cluster, `${model}`).toBeLessThan(t.dedupe);
    }
  });
});

describe('cluster reporting', () => {
  it('documents why a lone all-inclusive cluster is suppressed', () => {
    // Guard for the rule in pipeline.ts: themes are reported only when they
    // partition the results. Encoded here as the shapes, so the intent
    // survives a refactor of the pipeline.
    const reported = (sizes: number[], total: number): number[] => {
      const groups = sizes.filter((n) => n > 1);
      return groups.length === 1 && groups[0] === total ? [] : groups;
    };

    expect(reported([8], 8), 'one cluster holding everything').toEqual([]);
    expect(reported([1, 1, 1, 1], 4), 'all singletons').toEqual([]);
    expect(reported([3, 1, 1, 1, 1], 7), 'one real group among singletons').toEqual([3]);
    expect(reported([2, 2], 4), 'two real themes').toEqual([2, 2]);
    expect(reported([13, 2, 1, 1], 17), 'a blob plus a real pair').toEqual([13, 2]);
  });
});
