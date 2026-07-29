/**
 * Similarity thresholds, per embedding model.
 *
 * A cosine threshold is not a property of the task, it is a property of the
 * *model*: each one places "the same story" and "the same topic" at different
 * points on the scale. Hard-coding one number and then changing models
 * silently changes what the pipeline considers a duplicate.
 *
 * Every number here was measured through the pipeline's own text path
 * (`resultToEmbedText` on real Exa results). A calibration that formats text
 * differently from the pipeline measures the wrong thing — that mistake is
 * how the previous single default came to be far outside the range it was
 * supposed to operate in.
 */

import type { EmbedModelName } from '../voxell/types.js';

export interface SimilarityThresholds {
  /**
   * At or above this, two results are the same story and one is collapsed.
   * Measured: it sits in the gap between each model's duplicate and
   * same-topic bands.
   */
  dedupe: number;
  /**
   * Average-linkage cutoff for grouping survivors into themes.
   *
   * **A weaker number than `dedupe`, and a compromise rather than a
   * measurement.** The pairwise distribution moves a long way with the query:
   * on a tightly-focused question every result sits between 0.67 and 0.95 and
   * a cutoff near 0.84 is what starts separating sub-themes, while on a
   * deliberately broad one nothing pairs above 0.78 and every result is its
   * own theme. No single constant serves both, so these are chosen to behave
   * sanely at each end. Clustering at a percentile of the observed
   * similarities would fix it properly — a design change, not a retune.
   */
  cluster: number;
}

/**
 * Measured 2026-07-29 over 45 results across three queries.
 *
 * | | true duplicate | different articles, same topic | max non-duplicate |
 * |---|---|---|---|
 * | `turbo` | 0.986 | 0.925–0.945 | 0.948 |
 * | `ultra-4k` | 0.980 | 0.823–0.895 | 0.908 |
 *
 * Both models separate the two cases, but by very different margins: 0.038 for
 * `turbo` against 0.072 for `ultra-4k`. The old 0.92 default sat *inside*
 * turbo's non-duplicate band, which is why distinct articles that merely
 * shared a topic were being collapsed into one another. Each `dedupe` value
 * below sits in the middle of that model's gap.
 *
 * Two honest caveats:
 *
 * - The duplicate band rests on few genuine same-story pairs, because search
 *   results mostly are not duplicates. The non-duplicate ceiling is the
 *   well-sampled half, and it is the one that matters for over-collapsing.
 * - `cluster` is a weaker number than `dedupe`. See the note on it below.
 */
const BY_MODEL: Record<string, SimilarityThresholds> = {
  'ultra-4k': { dedupe: 0.94, cluster: 0.8 },
  'forge-ultra-4k': { dedupe: 0.94, cluster: 0.8 },
  'text-embedding-3-large': { dedupe: 0.94, cluster: 0.8 },

  turbo: { dedupe: 0.95, cluster: 0.84 },
  'forge-turbo': { dedupe: 0.95, cluster: 0.84 },
};

/**
 * For models that have not been measured — `pro` among them.
 *
 * Deliberately strict on `dedupe`: collapsing two results that are merely
 * related destroys information the user came for, while failing to collapse a
 * true duplicate only costs them a repeated line. Interpolating a value for
 * `pro` from its neighbours would look like a measurement and would not be
 * one, so it falls through to here until somebody measures it.
 */
export const UNMEASURED_THRESHOLDS: SimilarityThresholds = { dedupe: 0.95, cluster: 0.82 };

/** Thresholds for `model`, falling back to conservative defaults. */
export function thresholdsFor(model: EmbedModelName | undefined): SimilarityThresholds {
  if (!model) return UNMEASURED_THRESHOLDS;
  return BY_MODEL[model] ?? UNMEASURED_THRESHOLDS;
}

/** True when the model has measured thresholds rather than the fallback. */
export function isCalibrated(model: EmbedModelName | undefined): boolean {
  return Boolean(model && model in BY_MODEL);
}
