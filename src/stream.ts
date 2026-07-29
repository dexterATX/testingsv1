/**
 * Server-sent event parsing for `stream: true` searches.
 *
 * Exa emits OpenAI-compatible chat-completion chunks terminated by a
 * `data: [DONE]` sentinel.
 */

import { ExaError } from './errors.js';
import type { StreamChunk } from './types.js';

const DONE_SENTINEL = '[DONE]';

/**
 * Splits a raw SSE byte stream into decoded event payloads.
 *
 * Follows the SSE framing rules: events are separated by a blank line,
 * `:`-prefixed lines are comments, and multiple `data:` lines within one event
 * are joined with newlines.
 */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushEvent = (rawEvent: string): string | undefined => {
    const dataLines: string[] = [];

    for (const line of rawEvent.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;

      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      if (field !== 'data') continue;

      let value = separator === -1 ? '' : line.slice(separator + 1);
      // A single leading space after the colon is part of the framing.
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }

    return dataLines.length > 0 ? dataLines.join('\n') : undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        const trailing = flushEvent(buffer);
        if (trailing !== undefined && trailing !== '') yield trailing;
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // Events are delimited by a blank line; tolerate CRLF.
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary).replace(/\r/g, '');
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary));
        buffer = buffer.slice(boundary + (match ? match[0].length : 2));

        const data = flushEvent(rawEvent);
        if (data !== undefined && data !== '') yield data;

        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Decodes an SSE body into `StreamChunk` objects, stopping at the `[DONE]`
 * sentinel. Malformed JSON payloads are skipped rather than aborting the
 * stream, since a single bad frame should not discard everything before it.
 */
export async function* parseSearchStream(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<StreamChunk, void, undefined> {
  if (!body) {
    throw new ExaError('Streaming response had no body.');
  }

  for await (const payload of parseEventStream(body)) {
    if (payload === DONE_SENTINEL) return;

    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }

    if (typeof chunk === 'object' && chunk !== null) {
      yield chunk as StreamChunk;
    }
  }
}

/** Pulls just the incremental text out of a chunk stream. */
export async function* streamText(
  chunks: AsyncIterable<StreamChunk>,
): AsyncGenerator<string, void, undefined> {
  for await (const chunk of chunks) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content !== '') yield content;
  }
}
