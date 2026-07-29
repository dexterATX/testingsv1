import { describe, expect, it } from 'vitest';

import { parseEventStream, parseSearchStream, streamText } from '../../src/exa/stream.js';
import { ExaError } from '../../src/exa/errors.js';
import type { StreamChunk } from '../../src/exa/types.js';

/** Builds a byte stream from the given frames, one enqueue per frame. */
function streamOf(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseEventStream', () => {
  it('splits events on blank lines', async () => {
    const events = await collect(parseEventStream(streamOf('data: one\n\ndata: two\n\n')));

    expect(events).toEqual(['one', 'two']);
  });

  it('reassembles events split across chunk boundaries', async () => {
    const events = await collect(
      parseEventStream(streamOf('data: {"a":', '1}\n\ndata: {"b"', ':2}\n\n')),
    );

    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles a multi-byte character split across chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: café\n\n');
    const split = 10; // lands inside the two-byte é

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });

    expect(await collect(parseEventStream(stream))).toEqual(['café']);
  });

  it('joins multiple data lines within one event', async () => {
    const events = await collect(parseEventStream(streamOf('data: line one\ndata: line two\n\n')));

    expect(events).toEqual(['line one\nline two']);
  });

  it('ignores comment lines and non-data fields', async () => {
    const events = await collect(
      parseEventStream(streamOf(': keep-alive\n\nevent: ping\nid: 7\ndata: payload\n\n')),
    );

    expect(events).toEqual(['payload']);
  });

  it('tolerates CRLF line endings', async () => {
    const events = await collect(parseEventStream(streamOf('data: one\r\n\r\ndata: two\r\n\r\n')));

    expect(events).toEqual(['one', 'two']);
  });

  it('emits a trailing event that was not terminated by a blank line', async () => {
    const events = await collect(parseEventStream(streamOf('data: one\n\ndata: two')));

    expect(events).toEqual(['one', 'two']);
  });

  it('preserves only the single framing space after the colon', async () => {
    const events = await collect(parseEventStream(streamOf('data:  two spaces\n\n')));

    expect(events).toEqual([' two spaces']);
  });

  it('returns nothing for an empty stream', async () => {
    expect(await collect(parseEventStream(streamOf()))).toEqual([]);
  });
});

describe('parseSearchStream', () => {
  it('decodes chunks and stops at the [DONE] sentinel', async () => {
    const chunks = await collect(
      parseSearchStream(
        streamOf(
          'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
          'data: [DONE]\n\n',
          'data: {"choices":[{"delta":{"content":"never"}}]}\n\n',
        ),
      ),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices?.[0]?.delta?.content).toBe('a');
  });

  it('skips malformed frames instead of aborting the stream', async () => {
    const chunks = await collect(
      parseSearchStream(
        streamOf('data: {"ok":1}\n\n', 'data: {not json\n\n', 'data: {"ok":2}\n\n'),
      ),
    );

    expect(chunks.map((c) => c['ok'])).toEqual([1, 2]);
  });

  it('surfaces results and grounding attached to a chunk', async () => {
    const payload = {
      results: [{ id: 'x', url: 'https://example.com', title: 'T' }],
      output: { content: 'done', grounding: [] },
    };
    const chunks = await collect(
      parseSearchStream(streamOf(`data: ${JSON.stringify(payload)}\n\n`)),
    );

    expect(chunks[0]!.results?.[0]?.url).toBe('https://example.com');
    expect(chunks[0]!.output?.content).toBe('done');
  });

  it('throws when the response has no body', async () => {
    await expect(collect(parseSearchStream(null))).rejects.toThrow(ExaError);
  });
});

describe('streamText', () => {
  it('yields only non-empty delta content', async () => {
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { choices: [{ delta: { role: 'assistant' } }] };
      yield { choices: [{ delta: { content: 'Hello' } }] };
      yield { choices: [{ delta: { content: '' } }] };
      yield { results: [] };
      yield { choices: [{ delta: { content: ' world' } }] };
    }

    expect((await collect(streamText(source()))).join('')).toBe('Hello world');
  });
});
