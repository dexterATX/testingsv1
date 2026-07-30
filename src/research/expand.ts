/**
 * Turning one research question into several searches.
 *
 * Exa caps results per request at the plan ceiling and has no pagination, so
 * extra searches are the only way to widen recall — measured at 50 unique
 * results for one search against 170 for four. `extraSearches` in the pipeline
 * has always accepted them; what was missing is that nobody types four
 * rephrasings of their own question, so the net stayed narrow in practice.
 *
 * This takes a `Completer` rather than an SDK client, for the same reason
 * synthesis does: the prompt and — much more importantly — the validation are
 * testable with a stub and no network. **The pipeline itself stays free of any
 * LLM dependency.** `researchSearch` takes only a search client and an
 * embeddings client, so callers without a write-up key can still search, and
 * the offline suite stays hermetic. Callers that want expansion run it first
 * and pass the result in as ordinary extra searches.
 */

import type { Completer } from '../synthesis/types.js';

export interface ExpandOptions {
  /** Where the paraphrases come from — see `anthropicCompleter`. */
  completer: Completer;
  /** How many to ask for. Defaults to 3; more than 6 is rejected. */
  count?: number;
  /** Output cap for the completion. Defaults to 512. */
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Told what went wrong when expansion is skipped.
   *
   * Returning `[]` is the right behaviour and the wrong diagnostic: a failed
   * call and a model that answered in prose look identical from the outside,
   * and both look like "expansion just doesn't do anything". Callers that have
   * somewhere to put the reason should pass this.
   */
  onError?: (error: unknown) => void;
}

const DEFAULT_COUNT = 3;
const MAX_COUNT = 6;
/** Longer than this is prose, not a search query. */
const MAX_QUERY_CHARS = 200;

const SYSTEM_PROMPT = `You rewrite a research question as alternative search queries.

Rules:
- Return ONLY the queries, one per line. No numbering, no commentary, no blank lines.
- Each must be a different angle on the same question — different vocabulary, a
  narrower sub-question, or the practitioner's phrasing rather than the
  academic one.
- Do NOT restate the original question in near-identical words; a paraphrase
  that retrieves the same pages is wasted.
- Keep each under 20 words, and phrase it as something someone would type into
  a search engine.`;

/**
 * Rewrites `query` as up to `count` alternative searches.
 *
 * Returns `[]` rather than throwing when the model misbehaves. Expansion is an
 * enhancement to a search that already works, so a model that returns prose,
 * or refuses, or repeats the question, must cost nothing — degrading to a
 * plain single search is always an acceptable outcome, and a garbage query is
 * not.
 */
export async function expandQuery(query: string, options: ExpandOptions): Promise<string[]> {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed === '') return [];

  const count = Math.min(Math.max(options.count ?? DEFAULT_COUNT, 1), MAX_COUNT);

  let text: string;
  try {
    const completion = await options.completer({
      system: SYSTEM_PROMPT,
      prompt: `Research question:\n${trimmed}\n\nWrite ${count} alternative search queries.`,
      maxTokens: options.maxTokens ?? 512,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    text = completion.text;
  } catch (error) {
    // A refusal, a timeout, a missing key — none of these should stop a search
    // the user could otherwise have run.
    options.onError?.(error);
    return [];
  }

  return parseExpansions(text, trimmed, count);
}

/**
 * Pulls queries out of a completion, discarding anything that is not one.
 *
 * Exported for tests: this validation, not the prompt, is what stands between
 * a chatty model and a wasted paid search.
 */
export function parseExpansions(text: string, original: string, count: number): string[] {
  const seen = new Set([normalizeQuery(original)]);
  const queries: string[] = [];

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = cleanLine(rawLine);

    if (line === '' || line.length > MAX_QUERY_CHARS) continue;
    // A line ending in a colon is a heading — "Here are three queries:".
    if (line.endsWith(':')) continue;

    const key = normalizeQuery(line);
    if (key === '' || seen.has(key)) continue;

    seen.add(key);
    queries.push(line);
    if (queries.length >= count) break;
  }

  return queries;
}

/**
 * Recovers the query from a line the model decorated.
 *
 * Same model, same prompt, twice: once it returned three bare lines, once it
 * returned
 *
 * ```
 * 1. **"database credential rotation best practices"** — for security guidelines
 * ```
 *
 * Both are common enough that rejecting the second would make expansion work
 * only some of the time, for no reason the user could see. The queries in it
 * are perfectly good; only the packaging is wrong. Salvage rather than reject
 * — but salvage *precisely*, because whatever survives here is paid for.
 */
function cleanLine(raw: string): string {
  let line = raw
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();

  // **query**, *query*, __query__ — unwrap, keeping the contents.
  line = line.replace(/(\*\*|__|\*|_)(.+?)\1/g, '$2').trim();

  // When a line quotes its query, the quotes are the boundary and anything
  // after them is the model explaining itself.
  const quoted = /^["'“](.+?)["'”]/.exec(line);
  if (quoted) return quoted[1]!.trim();

  /*
   * "query — why I chose it". Dashes only when spaced and em/en: a plain
   * hyphen is ordinary inside a search query ("zero-downtime rotation"), and
   * truncating a real query is a worse trade than keeping a short trailing
   * clause on the rare line that uses one.
   */
  const [head = ''] = line.split(/\s+[—–]\s+/);

  return head.replace(/^["'`“”]|["'`“”]$/g, '').trim();
}

/**
 * Case and punctuation insensitive, so a requoted original is still a repeat.
 *
 * Exported because the caller has to dedupe too: `expandQuery` only knows the
 * one question it was given, so a generated line can still collide with a
 * query the user typed by hand, and that costs a paid search for nothing.
 */
export function normalizeQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
