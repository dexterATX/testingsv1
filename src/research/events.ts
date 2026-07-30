/**
 * Progress events emitted while a research run is in flight.
 *
 * The pipeline is one call, but it has distinct stages with useful
 * intermediate state — most obviously the raw Exa hits, which arrive long
 * before the reranked, deduped, synthesized result. A caller that wants to
 * show its work (the web UI, a verbose CLI) subscribes to these; a caller that
 * just wants the report ignores them.
 *
 * Handlers are called synchronously and their errors are swallowed: a broken
 * progress listener must never fail the research run.
 */

import type { CostDollars, ExaResult } from '../exa/types.js';

export interface RankedPreview {
  url: string;
  title: string | null;
  score: number;
  originalRank: number;
  rankDelta: number;
  duplicateCount: number;
}

export interface ClusterPreview {
  label: string;
  members: number[];
  cohesion: number;
}

export type ResearchEvent =
  | { type: 'search:start'; query: string; numResults: number }
  /** The raw Exa hits, before anything has been dropped or reordered. */
  | {
      type: 'search:done';
      requestId: string;
      results: ExaResult[];
      costDollars: CostDollars | undefined;
    }
  | { type: 'dedupe:exact'; removed: number; kept: number }
  | { type: 'chunk:done'; documents: number; passages: number }
  | { type: 'embed:start'; texts: number }
  | {
      type: 'embed:done';
      dim: number;
      model: string;
      tokens: number;
      cacheHits: number;
      latencyMs: number;
    }
  | { type: 'rerank:done'; ranked: RankedPreview[] }
  | { type: 'dedupe:near'; collapsed: number; kept: number }
  /** Fetching full page text for the survivors worth re-scoring closely. */
  | { type: 'hydrate:start'; results: number }
  | {
      type: 'hydrate:done';
      /** URLs whose full text came back and was re-scored. */
      hydrated: number;
      /** URLs Exa could not fetch; these keep their first-pass score. */
      failed: number;
      passages: number;
      /** How many of the re-scored results changed position. */
      moved: number;
    }
  | { type: 'cluster:done'; clusters: ClusterPreview[] }
  | { type: 'done'; results: number };

export type ResearchEventHandler = (event: ResearchEvent) => void;

/**
 * Wraps a handler so a throwing listener cannot take down the run.
 * Returns a no-op when no handler was supplied.
 */
export function safeEmitter(handler: ResearchEventHandler | undefined): ResearchEventHandler {
  if (!handler) return () => {};

  return (event) => {
    try {
      handler(event);
    } catch {
      // A progress listener is observational; its failure is not the run's.
    }
  };
}
