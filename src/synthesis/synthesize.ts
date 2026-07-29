/**
 * Turning a ranked, deduped result set into a grounded write-up.
 *
 * The value here is not the prose — it is that every claim traces to a
 * numbered source, and that the citations are *checked* rather than trusted.
 * A model can emit `[7]` when only six sources exist; `invalidMarkers` catches
 * exactly that, and `uncitedMarkers` shows what the write-up ignored.
 */

import type { ExaResult } from '../exa/types.js';
import type { RankedResult, ResearchReport } from '../research/pipeline.js';
import { SynthesisError, type Completer } from './types.js';

export interface SynthesizeOptions {
  /** Where the text comes from — see `anthropicCompleter`. */
  completer: Completer;
  /** Cap on sources included. Defaults to every result in the report. */
  maxSources?: number;
  /** Characters of evidence quoted per source. Defaults to 1200. */
  evidenceChars?: number;
  /** Extra instruction appended to the system prompt. */
  guidance?: string;
  /** Output cap. Defaults to the completer's own default. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface SynthesisSource {
  /** 1-based citation marker used in the text. */
  marker: number;
  result: ExaResult;
  /** Similarity to the research question. */
  score: number;
  /** Whether the write-up actually cited it. */
  cited: boolean;
}

export interface Synthesis {
  query: string;
  /** The grounded write-up, with `[n]` markers. */
  text: string;
  sources: SynthesisSource[];
  /**
   * Markers the model emitted that map to no source — a fabricated citation.
   * A non-empty array here means the write-up should not be trusted as-is.
   */
  invalidMarkers: number[];
  /** Sources the write-up never cited. */
  uncitedMarkers: number[];
  model: string | undefined;
  stopReason: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
}

const DEFAULT_EVIDENCE_CHARS = 1_200;

const SYSTEM_PROMPT = `You are a research analyst. You will be given a question and a numbered list of sources, each with a title, URL, and an extract.

Write a grounded synthesis that answers the question.

Rules:
- Cite every substantive claim with the source's number in square brackets, like [1] or [2,3].
- Use ONLY the numbered sources provided. Never cite a number that is not in the list.
- If the sources disagree, say so explicitly and cite both sides.
- If the sources do not answer part of the question, say that plainly rather than filling the gap from memory.
- Do not add a "Sources" or "References" section; the citation markers are enough.
- Lead with the answer. Supporting detail comes after.
- Write prose, not a bulleted list of source summaries. The reader wants the synthesis, not a catalogue.`;

/** Renders one source block for the prompt. */
function formatSource(entry: RankedResult, marker: number, evidenceChars: number): string {
  const evidence = (entry.bestChunk?.text ?? entry.embeddedText)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, evidenceChars);

  const lines = [
    `[${marker}] ${entry.result.title ?? '(untitled)'}`,
    `URL: ${entry.result.url}`,
  ];

  if (entry.result.publishedDate) lines.push(`Published: ${entry.result.publishedDate}`);
  if (entry.duplicates.length > 0) {
    lines.push(`Also reported by ${entry.duplicates.length} other source(s).`);
  }
  lines.push(`Extract: ${evidence}`);

  return lines.join('\n');
}

/** Pulls every `[n]` and `[n,m]` marker out of the text. */
export function extractCitationMarkers(text: string): number[] {
  const markers = new Set<number>();

  for (const match of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of (match[1] as string).split(',')) {
      const value = Number.parseInt(part.trim(), 10);
      if (Number.isInteger(value)) markers.add(value);
    }
  }

  return [...markers].sort((a, b) => a - b);
}

/**
 * Synthesizes a grounded write-up from a research report.
 *
 * @example
 * const synthesis = await synthesize(report, {
 *   completer: anthropicCompleter(),
 *   maxSources: 10,
 * });
 *
 * if (synthesis.invalidMarkers.length > 0) {
 *   console.warn('fabricated citations:', synthesis.invalidMarkers);
 * }
 */
export async function synthesize(
  report: ResearchReport,
  options: SynthesizeOptions,
): Promise<Synthesis> {
  const { completer, guidance, maxTokens = 0, signal } = options;
  const evidenceChars = options.evidenceChars ?? DEFAULT_EVIDENCE_CHARS;

  const selected =
    options.maxSources !== undefined
      ? report.results.slice(0, options.maxSources)
      : report.results;

  if (selected.length === 0) {
    throw new SynthesisError(
      'Nothing to synthesize — the research report has no results. ' +
        'Loosen minScore or broaden the query.',
    );
  }

  const sourceBlocks = selected.map((entry, index) =>
    formatSource(entry, index + 1, evidenceChars),
  );

  const prompt = [
    `Question: ${report.query}`,
    '',
    `Sources (${selected.length}):`,
    '',
    sourceBlocks.join('\n\n'),
  ].join('\n');

  const system = guidance ? `${SYSTEM_PROMPT}\n\n${guidance}` : SYSTEM_PROMPT;

  const completion = await completer({
    system,
    prompt,
    maxTokens,
    signal,
  });

  const markers = extractCitationMarkers(completion.text);
  const valid = new Set(selected.map((_, index) => index + 1));

  const sources: SynthesisSource[] = selected.map((entry, index) => ({
    marker: index + 1,
    result: entry.result,
    score: entry.score,
    cited: markers.includes(index + 1),
  }));

  return {
    query: report.query,
    text: completion.text,
    sources,
    invalidMarkers: markers.filter((marker) => !valid.has(marker)),
    uncitedMarkers: sources.filter((source) => !source.cited).map((source) => source.marker),
    model: completion.model,
    stopReason: completion.stopReason,
    usage: completion.usage,
  };
}
