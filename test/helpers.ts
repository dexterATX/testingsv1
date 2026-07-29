/** Shared fixtures for the client tests. */

import type { SearchResponse } from '../src/exa/types.js';

export interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

export function textResponse(
  text: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/html', ...init.headers },
  });
}

export function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * A fetch stub that returns queued responses in order and records every call.
 * A queued entry may be an Error, which is thrown instead (to simulate a
 * network failure).
 */
export function mockFetch(queue: Array<Response | Error>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const pending = [...queue];

  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    calls.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });

    const next = pending.shift();
    if (!next) throw new Error(`mockFetch: unexpected call #${calls.length} to ${String(input)}`);
    if (next instanceof Error) throw next;
    return next;
  };

  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

/** A fetch stub that never resolves until its signal aborts. */
export const hangingFetch = ((_input: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  })) as unknown as typeof globalThis.fetch;

export const SEARCH_FIXTURE: SearchResponse = {
  requestId: 'req_test_123',
  searchType: 'auto',
  results: [
    {
      id: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Example A',
      publishedDate: '2025-01-01T00:00:00.000Z',
      author: null,
      highlights: ['a relevant excerpt'],
      highlightScores: [0.91],
    },
  ],
  costDollars: { total: 0.005 },
};

/** Never sleep for real in tests. */
export const noSleep = async (): Promise<void> => {};
