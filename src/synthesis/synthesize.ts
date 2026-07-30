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
  /**
   * Characters of evidence quoted per source. Defaults to 4200.
   *
   * A hydrated result carries several passages and each one is already
   * ~1350 characters, so a budget sized for one passage does not select
   * between them — it truncates the rest away.
   */
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

const DEFAULT_EVIDENCE_CHARS = 4_200;

/**
 * Below this, a passage is too short to be worth the tokens it costs and the
 * confusion a fragment causes; the budget stops rather than adding a stub.
 */
const MIN_PASSAGE_CHARS = 300;

/** Shortest suffix/prefix match treated as real chunk overlap, not coincidence. */
const MIN_OVERLAP_CHARS = 24;
/** Chunking's overlap is 150 by default; allow headroom without scanning far. */
const MAX_OVERLAP_CHARS = 400;

/** Marks a jump between passages that are not adjacent in the source. */
const GAP = ' […] ';

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

/**
 * Trims the part of `next` that `previous` already said.
 *
 * Chunks are cut with a fixed overlap, so consecutive passages repeat their
 * boundary verbatim. Quoting it twice wastes budget and reads as emphasis the
 * source never gave. The overlap is measured rather than assumed, since the
 * chunker's setting is a caller option and the text is normalised first.
 */
function dropOverlap(previous: string, next: string): string {
  const limit = Math.min(MAX_OVERLAP_CHARS, previous.length, next.length);

  for (let size = limit; size >= MIN_OVERLAP_CHARS; size -= 1) {
    if (previous.endsWith(next.slice(0, size))) return next.slice(size).trimStart();
  }

  return next;
}

/**
 * Builds the extract quoted for one source.
 *
 * Hydrated results carry several passages — the ones that actually matched the
 * question, kept in document order so the write-up reads them as an argument
 * rather than a scoreboard. Non-adjacent passages are separated by `[…]`: two
 * excerpts from opposite ends of a page, joined seamlessly, would read as one
 * continuous claim the source never made.
 *
 * Falls back to the single best chunk, then to the embedded text, for results
 * the second pass never reached.
 */
function buildEvidence(entry: RankedResult, evidenceChars: number): string {
  const passages = entry.topChunks ?? [];

  if (passages.length === 0) {
    return (entry.bestChunk?.text ?? entry.embeddedText)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, evidenceChars);
  }

  let evidence = '';
  let previousIndex: number | undefined;

  for (const passage of passages) {
    const normalized = passage.text.replace(/\s+/g, ' ').trim();
    if (normalized === '') continue;

    const adjacent = previousIndex !== undefined && passage.index === previousIndex + 1;
    // Against the whole accumulated extract, whose tail *is* the previous
    // passage — and which is already normalised the same way.
    const body = adjacent ? dropOverlap(evidence, normalized) : normalized;

    if (body === '') {
      previousIndex = passage.index;
      continue;
    }

    const separator = evidence === '' ? '' : adjacent ? ' ' : GAP;
    const remaining = evidenceChars - evidence.length - separator.length;

    // Stop rather than tail off mid-passage: a fragment too short to carry a
    // claim still costs tokens and invites a citation to nothing.
    if (remaining < MIN_PASSAGE_CHARS) break;

    evidence += separator + body.slice(0, remaining);
    previousIndex = passage.index;
  }

  return evidence;
}

/** Renders one source block for the prompt. */
function formatSource(entry: RankedResult, marker: number, evidenceChars: number): string {
  const evidence = buildEvidence(entry, evidenceChars);

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
