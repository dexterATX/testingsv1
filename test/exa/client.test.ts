import { describe, expect, it } from 'vitest';

import { ExaClient } from '../../src/exa/client.js';
import {
  ExaAuthError,
  ExaBadRequestError,
  ExaConnectionError,
  ExaError,
  ExaRateLimitError,
  ExaRequestValidationError,
  ExaServerError,
  ExaTimeoutError,
  ExaUnprocessableError,
} from '../../src/exa/errors.js';
import {
  SEARCH_FIXTURE,
  hangingFetch,
  jsonResponse,
  mockFetch,
  noSleep,
  sseResponse,
  textResponse,
} from '../helpers.js';

const API_KEY = 'test-key';

function makeClient(
  queue: Array<Response | Error>,
  options: Partial<ConstructorParameters<typeof ExaClient>[0]> = {},
) {
  const { fetch, calls } = mockFetch(queue);
  const client = new ExaClient({ apiKey: API_KEY, fetch, sleep: noSleep, ...options });
  return { client, calls };
}

describe('construction', () => {
  it('reads the key from EXA_API_KEY', () => {
    const previous = process.env['EXA_API_KEY'];
    process.env['EXA_API_KEY'] = 'from-env';
    try {
      expect(() => new ExaClient()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env['EXA_API_KEY'];
      else process.env['EXA_API_KEY'] = previous;
    }
  });

  it('throws an actionable error when no key is configured', () => {
    const previous = process.env['EXA_API_KEY'];
    delete process.env['EXA_API_KEY'];
    try {
      expect(() => new ExaClient()).toThrow(ExaRequestValidationError);
      expect(() => new ExaClient()).toThrow(/Missing Exa API key/);
    } finally {
      if (previous !== undefined) process.env['EXA_API_KEY'] = previous;
    }
  });

  it('strips trailing slashes from a custom base URL', async () => {
    const { client, calls } = makeClient([jsonResponse(SEARCH_FIXTURE)], {
      baseUrl: 'https://proxy.internal/exa///',
    });

    await client.search('q');

    expect(calls[0]!.url).toBe('https://proxy.internal/exa/search');
  });
});

describe('search', () => {
  it('posts to /search with the documented headers and body', async () => {
    const { client, calls } = makeClient([jsonResponse(SEARCH_FIXTURE)]);

    const response = await client.search('your search query here', {
      type: 'auto',
      numResults: 10,
      contents: { highlights: true },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.exa.ai/search');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['Content-Type']).toBe('application/json');

    expect(call.body).toEqual({
      query: 'your search query here',
      type: 'auto',
      numResults: 10,
      contents: { highlights: true },
    });

    expect(response).toEqual(SEARCH_FIXTURE);
    expect(response.results[0]!.highlights).toEqual(['a relevant excerpt']);
  });

  it('does not send transport-only options in the body', async () => {
    const { client, calls } = makeClient([jsonResponse(SEARCH_FIXTURE)]);

    await client.search('q', { timeoutMs: 1000, signal: new AbortController().signal });

    expect(calls[0]!.body).toEqual({ query: 'q' });
  });

  it('omits `stream` on non-streaming calls', async () => {
    const { client, calls } = makeClient([jsonResponse(SEARCH_FIXTURE)]);

    await client.search('q');

    expect(calls[0]!.body).not.toHaveProperty('stream');
  });

  it('passes deep-search synthesis parameters through untouched', async () => {
    const { client, calls } = makeClient([jsonResponse(SEARCH_FIXTURE)]);

    const outputSchema = {
      type: 'object' as const,
      required: ['summary'],
      properties: { summary: { type: 'string' as const, description: 'A grounded summary' } },
    };

    await client.search('q', {
      type: 'deep',
      systemPrompt: 'Prefer official sources.',
      outputSchema,
      additionalQueries: ['angle one', 'angle two'],
      contents: { highlights: true },
    });

    expect(calls[0]!.body).toMatchObject({
      type: 'deep',
      systemPrompt: 'Prefer official sources.',
      outputSchema,
      additionalQueries: ['angle one', 'angle two'],
    });
  });

  it('types output.content from the generic parameter', async () => {
    const payload = {
      requestId: 'req_1',
      results: [],
      output: {
        content: { companies: [{ name: 'Nvidia' }] },
        grounding: [
          {
            field: 'companies[0].name',
            citations: [{ url: 'https://example.com', title: 'Source' }],
            confidence: 'high' as const,
          },
        ],
      },
    };
    const { client } = makeClient([jsonResponse(payload)]);

    const response = await client.search<{ companies: Array<{ name: string }> }>('q', {
      outputSchema: { type: 'object', properties: { companies: { type: 'array' } } },
    });

    expect(response.output?.content.companies[0]!.name).toBe('Nvidia');
    expect(response.output?.grounding[0]!.confidence).toBe('high');
  });

  it('rejects invalid requests before any network call', async () => {
    const { client, calls } = makeClient([]);

    await expect(client.search('q', { numResults: 500 })).rejects.toThrow(
      ExaRequestValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('error mapping', () => {
  it.each([
    [400, ExaBadRequestError],
    [401, ExaAuthError],
    [422, ExaUnprocessableError],
  ])('maps %s to the matching error class', async (status, expected) => {
    const { client } = makeClient([jsonResponse({ error: 'nope' }, { status })]);

    await expect(client.search('q')).rejects.toThrow(expected);
  });

  it('surfaces the API error message, status, and requestId', async () => {
    const { client } = makeClient([
      jsonResponse(
        { requestId: 'req_bad', error: 'excludeDomains is not supported for this category' },
        { status: 400 },
      ),
    ]);

    await expect(client.search('q')).rejects.toMatchObject({
      status: 400,
      requestId: 'req_bad',
      message: 'excludeDomains is not supported for this category',
    });
  });

  it('falls back to the x-request-id header', async () => {
    const { client } = makeClient([
      jsonResponse({ error: 'boom' }, { status: 400, headers: { 'x-request-id': 'req_hdr' } }),
    ]);

    await expect(client.search('q')).rejects.toMatchObject({ requestId: 'req_hdr' });
  });

  it('handles a non-JSON error body', async () => {
    const { client } = makeClient([textResponse('<html>502 Bad Gateway</html>', { status: 400 })]);

    await expect(client.search('q')).rejects.toThrow(/502 Bad Gateway/);
  });

  it('rejects a 200 response that is not JSON', async () => {
    const { client } = makeClient([textResponse('<html>login</html>')]);

    await expect(client.search('q')).rejects.toThrow(ExaError);
  });
});

describe('retries', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const { client, calls } = makeClient([
      jsonResponse({ error: 'rate limited' }, { status: 429 }),
      jsonResponse(SEARCH_FIXTURE),
    ]);

    const response = await client.search('q');

    expect(calls).toHaveLength(2);
    expect(response.requestId).toBe('req_test_123');
  });

  it('retries 5xx responses', async () => {
    const { client, calls } = makeClient([
      jsonResponse({ error: 'oops' }, { status: 500 }),
      jsonResponse({ error: 'oops' }, { status: 503 }),
      jsonResponse(SEARCH_FIXTURE),
    ]);

    await client.search('q');

    expect(calls).toHaveLength(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const { client, calls } = makeClient(
      [
        jsonResponse({ error: 'oops' }, { status: 500 }),
        jsonResponse({ error: 'oops' }, { status: 500 }),
      ],
      { maxRetries: 1 },
    );

    await expect(client.search('q')).rejects.toThrow(ExaServerError);
    expect(calls).toHaveLength(2);
  });

  it('does not retry client errors', async () => {
    const { client, calls } = makeClient([jsonResponse({ error: 'bad key' }, { status: 401 })]);

    await expect(client.search('q')).rejects.toThrow(ExaAuthError);
    expect(calls).toHaveLength(1);
  });

  it('retries network failures and reports them as connection errors', async () => {
    const { client, calls } = makeClient(
      [new TypeError('fetch failed'), new TypeError('fetch failed')],
      { maxRetries: 1 },
    );

    await expect(client.search('q')).rejects.toThrow(ExaConnectionError);
    expect(calls).toHaveLength(2);
  });

  it('honors Retry-After when deciding how long to wait', async () => {
    const delays: number[] = [];
    const { fetch } = mockFetch([
      jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } }),
      jsonResponse(SEARCH_FIXTURE),
    ]);
    const client = new ExaClient({
      apiKey: API_KEY,
      fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await client.search('q');

    expect(delays).toEqual([3000]);
  });

  it('exposes retryAfterSeconds on the rate limit error', async () => {
    const { client } = makeClient(
      [jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '7' } })],
      { maxRetries: 0 },
    );

    await expect(client.search('q')).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  it('caps backoff below the ceiling', async () => {
    const delays: number[] = [];
    const { fetch } = mockFetch([
      jsonResponse({ error: 'slow' }, { status: 429, headers: { 'retry-after': '9999' } }),
      jsonResponse(SEARCH_FIXTURE),
    ]);
    const client = new ExaClient({
      apiKey: API_KEY,
      fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await client.search('q');

    expect(delays[0]).toBeLessThanOrEqual(20_000);
  });
});

describe('timeouts', () => {
  it('raises ExaTimeoutError when the request exceeds the budget', async () => {
    const client = new ExaClient({
      apiKey: API_KEY,
      fetch: hangingFetch,
      sleep: noSleep,
      maxRetries: 0,
    });

    await expect(client.search('q', { timeoutMs: 20 })).rejects.toThrow(ExaTimeoutError);
  });

  it('propagates a caller abort as-is', async () => {
    const controller = new AbortController();
    const client = new ExaClient({ apiKey: API_KEY, fetch: hangingFetch, maxRetries: 0 });

    const promise = client.search('q', { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });
});

describe('contents', () => {
  it('posts urls with top-level content fields, not nested', async () => {
    const { client, calls } = makeClient([
      jsonResponse({ requestId: 'req_c', results: [], statuses: [] }),
    ]);

    await client.contents(['https://example.com/article'], {
      highlights: true,
      maxAgeHours: 24,
    });

    const call = calls[0]!;
    expect(call.url).toBe('https://api.exa.ai/contents');
    expect(call.body).toEqual({
      urls: ['https://example.com/article'],
      highlights: true,
      maxAgeHours: 24,
    });
    expect(call.body).not.toHaveProperty('contents');
  });

  it('returns per-url statuses', async () => {
    const { client } = makeClient([
      jsonResponse({
        requestId: 'req_c',
        results: [],
        statuses: [
          {
            id: 'https://example.com/missing',
            status: 'error',
            error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 },
          },
        ],
      }),
    ]);

    const response = await client.contents(['https://example.com/missing']);

    expect(response.statuses?.[0]!.status).toBe('error');
    expect(response.statuses?.[0]!.error?.tag).toBe('CRAWL_NOT_FOUND');
  });

  it('validates before calling', async () => {
    const { client, calls } = makeClient([]);

    await expect(client.contents([])).rejects.toThrow(ExaRequestValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe('answer', () => {
  it('posts the query and returns citations', async () => {
    const { client, calls } = makeClient([
      jsonResponse({
        requestId: 'req_a',
        answer: '$350 billion.',
        citations: [{ id: 'x', url: 'https://example.com', title: 'Source' }],
        costDollars: { total: 0.005 },
      }),
    ]);

    const response = await client.answer('What is the latest valuation of SpaceX?', {
      text: true,
    });

    expect(calls[0]!.url).toBe('https://api.exa.ai/answer');
    expect(calls[0]!.body).toEqual({
      query: 'What is the latest valuation of SpaceX?',
      text: true,
    });
    expect(response.answer).toBe('$350 billion.');
    expect(response.citations[0]!.url).toBe('https://example.com');
  });

  it('rejects an empty query', async () => {
    const { client, calls } = makeClient([]);

    await expect(client.answer('  ')).rejects.toThrow(ExaRequestValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe('searchStream', () => {
  it('sets stream:true and yields parsed chunks', async () => {
    const { fetch, calls } = mockFetch([
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ]);
    const client = new ExaClient({ apiKey: API_KEY, fetch });

    const chunks = [];
    for await (const chunk of client.searchStream('q', { type: 'fast' })) chunks.push(chunk);

    expect(calls[0]!.body).toMatchObject({ query: 'q', type: 'fast', stream: true });
    expect((calls[0]!.init.headers as Record<string, string>)['Accept']).toBe('text/event-stream');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.choices?.[0]?.delta?.content).toBe('Hello');
  });

  it('validates before opening the stream', async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new ExaClient({ apiKey: API_KEY, fetch });

    const iterator = client.searchStream('q', { numResults: 0 });

    await expect(iterator.next()).rejects.toThrow(ExaRequestValidationError);
    expect(calls).toHaveLength(0);
  });

  it('maps a streaming error response onto the normal error classes', async () => {
    const { fetch } = mockFetch([jsonResponse({ error: 'bad key' }, { status: 401 })]);
    const client = new ExaClient({ apiKey: API_KEY, fetch });

    const iterator = client.searchStream('q');

    await expect(iterator.next()).rejects.toThrow(ExaAuthError);
  });
});
