/**
 * End-to-end tests against a local stub of the Exa API.
 *
 * Unlike the unit tests these use the real global `fetch` over a real socket,
 * which covers what a fetch mock cannot: header serialization, SSE arriving
 * split across packets, and retry behavior against a live connection.
 *
 * No network access and no API key required — the stub listens on localhost.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExaClient } from '../../src/exa/client.js';
import { ExaBadRequestError, ExaRequestValidationError } from '../../src/exa/errors.js';
import { streamText } from '../../src/exa/stream.js';

interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const received: RecordedRequest[] = [];
let server: http.Server;
let client: ExaClient;
let rateLimitHitsLeft = 1;

function lastRequest(): RecordedRequest {
  const request = received.at(-1);
  if (!request) throw new Error('no request was recorded');
  return request;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });

    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      received.push({ path: req.url ?? '', headers: req.headers, body });

      const send = (
        status: number,
        payload: unknown,
        headers: Record<string, string> = {},
      ): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/search' && body['query'] === 'rate-limited') {
        if (rateLimitHitsLeft > 0) {
          rateLimitHitsLeft -= 1;
          send(429, { error: 'slow down' }, { 'retry-after': '0' });
          return;
        }
        send(200, { requestId: 'req_after_retry', results: [] });
        return;
      }

      if (req.url === '/search' && body['query'] === 'bad-filter') {
        send(400, { requestId: 'req_bad', error: 'unsupported filter' });
        return;
      }

      if (req.url === '/search' && body['stream'] === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        // Deliberately split one event across two writes.
        res.write('data: {"choices":[{"delta":{"content":"lo str');
        res.write('eam"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (req.url === '/search') {
        send(200, {
          requestId: 'req_search',
          searchType: 'auto',
          results: [
            { id: 'a', url: 'https://example.com/a', title: 'A', highlights: ['excerpt one'] },
          ],
          output: {
            content: { companies: [{ name: 'Nvidia' }] },
            grounding: [
              {
                field: 'companies[0].name',
                citations: [{ url: 'https://example.com/source' }],
                confidence: 'high',
              },
            ],
          },
          costDollars: { total: 0.005 },
        });
        return;
      }

      if (req.url === '/contents') {
        send(200, {
          requestId: 'req_contents',
          results: [{ id: 'u1', url: 'https://example.com/a', title: 'A' }],
          statuses: [
            { id: 'u1', status: 'success', source: 'cached' },
            { id: 'u2', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } },
          ],
        });
        return;
      }

      if (req.url === '/answer') {
        send(200, {
          requestId: 'req_answer',
          answer: '$350 billion.',
          citations: [{ id: 'c1', url: 'https://example.com', title: 'Source' }],
        });
        return;
      }

      send(404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  client = new ExaClient({
    apiKey: 'integration-key',
    baseUrl: `http://127.0.0.1:${port}`,
    retryBaseMs: 1,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('search over a real connection', () => {
  it('sends the documented request and parses results plus grounded output', async () => {
    const response = await client.search<{ companies: Array<{ name: string }> }>(
      'vector databases',
      { type: 'auto', numResults: 5, contents: { highlights: true } },
    );

    expect(response.requestId).toBe('req_search');
    expect(response.results[0]!.highlights).toEqual(['excerpt one']);
    expect(response.output?.content.companies[0]!.name).toBe('Nvidia');
    expect(response.output?.grounding[0]!.confidence).toBe('high');

    const sent = lastRequest();
    expect(sent.headers['x-api-key']).toBe('integration-key');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body).toEqual({
      query: 'vector databases',
      type: 'auto',
      numResults: 5,
      contents: { highlights: true },
    });
  });

  it('retries a 429 and returns the follow-up success', async () => {
    const response = await client.search('rate-limited');

    expect(response.requestId).toBe('req_after_retry');
  });

  it('raises ExaBadRequestError carrying status, requestId, and message', async () => {
    await expect(client.search('bad-filter')).rejects.toMatchObject({
      status: 400,
      requestId: 'req_bad',
      message: 'unsupported filter',
    });
    await expect(client.search('bad-filter')).rejects.toThrow(ExaBadRequestError);
  });

  it('short-circuits an invalid request without touching the network', async () => {
    const before = received.length;

    await expect(
      client.search('x', { category: 'people', excludeDomains: ['spam.com'] }),
    ).rejects.toThrow(ExaRequestValidationError);

    expect(received).toHaveLength(before);
  });
});

describe('contents over a real connection', () => {
  it('sends content fields top-level and reports per-url statuses', async () => {
    const response = await client.contents(
      ['https://example.com/a', 'https://example.com/b'],
      { highlights: true, maxAgeHours: 24 },
    );

    expect(response.statuses?.[1]!.error?.tag).toBe('CRAWL_NOT_FOUND');

    const sent = lastRequest();
    expect(sent.body).toEqual({
      urls: ['https://example.com/a', 'https://example.com/b'],
      highlights: true,
      maxAgeHours: 24,
    });
    expect(sent.body).not.toHaveProperty('contents');
  });
});

describe('answer over a real connection', () => {
  it('returns the answer and its citations', async () => {
    const response = await client.answer('What is the latest valuation of SpaceX?', {
      text: true,
    });

    expect(response.answer).toBe('$350 billion.');
    expect(response.citations[0]!.url).toBe('https://example.com');
    expect(lastRequest().body).toEqual({
      query: 'What is the latest valuation of SpaceX?',
      text: true,
    });
  });
});

describe('streaming over a real connection', () => {
  it('reassembles an SSE event split across two writes', async () => {
    let output = '';
    for await (const text of streamText(client.searchStream('stream me', { type: 'fast' }))) {
      output += text;
    }

    expect(output).toBe('Hello stream');
    expect(lastRequest().body['stream']).toBe(true);
  });
});
