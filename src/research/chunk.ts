/**
 * Splitting long text into embeddable chunks.
 *
 * One vector per document caps precision on long pages: a 10,000-word article
 * with one relevant paragraph averages that paragraph away against everything
 * else. Chunking embeds passages separately so the relevant one can score on
 * its own merits.
 *
 * Splits prefer paragraph boundaries, then sentence boundaries, and only
 * hard-cut mid-sentence when a single sentence exceeds the budget — keeping
 * chunks semantically whole is what makes their embeddings meaningful.
 */

export interface Chunk {
  text: string;
  /** Character offset of the chunk in the source text. */
  start: number;
  /** Character offset one past the end. */
  end: number;
  /** 0-based position in the chunk sequence. */
  index: number;
}

export interface ChunkOptions {
  /** Target maximum characters per chunk. Defaults to 1200. */
  maxChars?: number;
  /**
   * Characters of trailing context repeated at the start of the next chunk,
   * so a passage split across a boundary is still recoverable from one side.
   * Defaults to 150.
   */
  overlapChars?: number;
  /**
   * Chunks shorter than this are merged into the previous chunk rather than
   * standing alone — a 12-character fragment embeds to noise. Defaults to 120.
   */
  minChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;
const DEFAULT_MIN_CHARS = 120;

/** Splits on blank lines, then sentence ends, keeping the delimiter attached. */
function splitIntoUnits(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim() !== '');
  const units: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      units.push(paragraph);
      continue;
    }

    // Sentence-ish boundaries: terminator plus whitespace.
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (sentence.length <= maxChars) {
        units.push(sentence);
        continue;
      }

      // A single oversized sentence — hard-cut it as a last resort.
      for (let i = 0; i < sentence.length; i += maxChars) {
        units.push(sentence.slice(i, i + maxChars));
      }
    }
  }

  return units;
}

/**
 * Splits `text` into overlapping chunks.
 *
 * Returns a single chunk for text already under the budget, and an empty array
 * for blank input — callers must not pass an empty chunk to the embeddings
 * API, which answers blank input with a 502.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (maxChars < 1) throw new Error('`maxChars` must be at least 1.');

  // The default overlap scales down with a small budget — a caller who sets
  // only `maxChars` should not have to also lower `overlapChars` to keep the
  // pair coherent. An explicitly oversized overlap is still an error.
  const overlapChars =
    options.overlapChars ?? Math.min(DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 4));
  const minChars = options.minChars ?? Math.min(DEFAULT_MIN_CHARS, Math.floor(maxChars / 4));

  if (overlapChars < 0) throw new Error('`overlapChars` must not be negative.');
  if (overlapChars >= maxChars) {
    throw new Error(
      `\`overlapChars\` (${overlapChars}) must be less than \`maxChars\` (${maxChars}), ` +
        `or chunking cannot advance.`,
    );
  }

  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.length <= maxChars) {
    return [{ text: trimmed, start: 0, end: trimmed.length, index: 0 }];
  }

  const units = splitIntoUnits(trimmed, maxChars);
  const pieces: string[] = [];
  let current = '';

  for (const unit of units) {
    if (current === '') {
      current = unit;
      continue;
    }

    if (current.length + 1 + unit.length <= maxChars) {
      current = `${current} ${unit}`;
    } else {
      pieces.push(current);
      current = unit;
    }
  }
  if (current !== '') pieces.push(current);

  // Fold a runt tail into its predecessor rather than embedding a fragment.
  if (pieces.length > 1) {
    const last = pieces[pieces.length - 1] as string;
    if (last.length < minChars) {
      pieces.pop();
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1] as string} ${last}`;
    }
  }

  const chunks: Chunk[] = [];
  let cursor = 0;

  for (const [index, piece] of pieces.entries()) {
    // Locate the piece in the source so offsets point at real positions.
    const found = trimmed.indexOf(piece, cursor);
    const start = found === -1 ? cursor : found;

    const overlap =
      index > 0 && overlapChars > 0
        ? trimmed.slice(Math.max(0, start - overlapChars), start).trimStart()
        : '';

    const body = overlap === '' ? piece : `${overlap} ${piece}`;

    chunks.push({
      text: body,
      start: overlap === '' ? start : Math.max(0, start - overlap.length - 1),
      end: start + piece.length,
      index,
    });

    cursor = start + piece.length;
  }

  return chunks;
}
