import { describe, expect, it } from 'vitest';

import { VoxellClient, truncateForEmbedding } from '../../src/voxell/client.js';
import {
  VoxellAuthError,
  VoxellBadRequestError,
  VoxellError,
  VoxellPayloadTooLargeError,
  VoxellRequestValidationError,
} from '../../src/voxell/errors.js';
import { LIMITS } from '../../src/voxell/types.js';
import { embedStub, fakeVector, jsonResponse, noSleep } from './helpers.js';

const API_KEY = 'vf_sk_test';

function makeClient(
  stub: ReturnType<typeof embedStub>,
  options: Partial<ConstructorParameters<typeof VoxellClient>[0]> = {},
) {
  return new VoxellClient({ apiKey: API_KEY, fetch: stub.fetch, sleep: noSleep, ...options });
}

describe('construction', () => {
  it('reads the key from VOXELL_API_KEY', () => {
    const previous = process.env['VOXELL_API_KEY'];
    process.env['VOXELL_API_KEY'] = 'from-env';
    try {
      expect(() => new VoxellClient()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env['VOXELL_API_KEY'];
      else process.env['VOXELL_API_KEY'] = previous;
    }
  });

  it('throws an actionable error when no key is configured', () => {
    const previous = process.env['VOXELL_API_KEY'];
    delete process.env['VOXELL_API_KEY'];
    try {
      expect(() => new VoxellClient()).toThrow(VoxellRequestValidationError);
      expect(() => new VoxellClient()).toThrow(/Missing Voxell API key/);
    } finally {
      if (previous !== undefined) process.env['VOXELL_API_KEY'] = previous;
    }
  });

  it('rejects a batchSize below 1', () => {
    expect(() => new VoxellClient({ apiKey: API_KEY, batchSize: 0 })).toThrow(
      VoxellRequestValidationError,
    );
  });
});

describe('embed', () => {
  it('sends the Bearer prefix, which the API requires', async () => {
    const stub = embedStub();
    await makeClient(stub).embed(['hello']);

    expect(stub.calls[0]!.headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(stub.calls[0]!.url).toBe('https://api.voxell.ai/v1/embed');
  });

  it('returns one vector per input, in input order', async () => {
    const stub = embedStub();
    const result = await makeClient(stub).embed(['alpha', 'beta', 'gamma']);

    expect(result.embeddings).toHaveLength(3);
    expect(result.embeddings[0]).toEqual(fakeVector('alpha'));
    expect(result.embeddings[1]).toEqual(fakeVector('beta'));
    expect(result.embeddings[2]).toEqual(fakeVector('gamma'));
    expect(result.dim).toBe(8);
    expect(result.model).toBe('qwen3-native-28l');
  });

  it('defaults to ultra-4k and honors an override', async () => {
    // The default is the top tier, not the API's own `turbo`: it separates
    // "same story" from "same topic" with about twice the margin, which is
    // what dedupe needs. See src/research/thresholds.ts.
    const before = process.env['VOXELL_MODEL'];
    delete process.env['VOXELL_MODEL'];

    try {
      const stub = embedStub();
      const client = makeClient(stub);

      await client.embed(['x']);
      expect(stub.calls[0]!.body.model).toBe('ultra-4k');

      await client.embed(['y'], { model: 'turbo' });
      expect(stub.calls[1]!.body.model).toBe('turbo');
    } finally {
      if (before === undefined) delete process.env['VOXELL_MODEL'];
      else process.env['VOXELL_MODEL'] = before;
    }
  });

  it('takes the default model from VOXELL_MODEL when set', async () => {
    // Reading the environment is what lets the deployed service switch tiers
    // without a code change; it also means this suite must control the var
    // explicitly, or a developer with it exported would see the test above
    // fail for no reason they could see.
    const before = process.env['VOXELL_MODEL'];
    process.env['VOXELL_MODEL'] = 'pro';

    try {
      const stub = embedStub();
      await makeClient(stub).embed(['x']);
      expect(stub.calls[0]!.body.model).toBe('pro');
    } finally {
      if (before === undefined) delete process.env['VOXELL_MODEL'];
      else process.env['VOXELL_MODEL'] = before;
    }
  });

  it('embedOne returns the bare vector', async () => {
    const stub = embedStub();
    const vector = await makeClient(stub).embedOne('solo');

    expect(vector).toEqual(fakeVector('solo'));
  });

  it('splits large inputs into batches and reassembles them in order', async () => {
    const stub = embedStub();
    const texts = Array.from({ length: 250 }, (_, i) => `doc ${i}`);

    const result = await makeClient(stub, { batchSize: 100 }).embed(texts);

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.map((c) => c.body.texts!.length)).toEqual([100, 100, 50]);
    expect(result.batches).toBe(3);
    expect(result.embeddings).toHaveLength(250);
    expect(result.embeddings[0]).toEqual(fakeVector('doc 0'));
    expect(result.embeddings[249]).toEqual(fakeVector('doc 249'));
    expect(result.tokens).toBe(250 * 3);
  });

  it('embeds a repeated text once and fans it back out', async () => {
    const stub = embedStub();
    const result = await makeClient(stub).embed(['same', 'other', 'same', 'same']);

    expect(stub.calls[0]!.body.texts).toEqual(['same', 'other']);
    expect(result.embeddings).toHaveLength(4);
    expect(result.embeddings[0]).toEqual(result.embeddings[2]);
    expect(result.embeddings[0]).toEqual(result.embeddings[3]);
    expect(result.embeddings[1]).toEqual(fakeVector('other'));
  });

  it('serves repeat calls from cache without another request', async () => {
    const stub = embedStub();
    const client = makeClient(stub);

    await client.embed(['cached one', 'cached two']);
    const second = await client.embed(['cached one', 'cached two']);

    expect(stub.calls).toHaveLength(1);
    expect(second.cacheHits).toBe(2);
    expect(second.batches).toBe(0);
    expect(second.embeddings[0]).toEqual(fakeVector('cached one'));
  });

  it('only requests the uncached remainder', async () => {
    const stub = embedStub();
    const client = makeClient(stub);

    await client.embed(['a']);
    const second = await client.embed(['a', 'b']);

    expect(stub.calls[1]!.body.texts).toEqual(['b']);
    expect(second.cacheHits).toBe(1);
    expect(second.embeddings[0]).toEqual(fakeVector('a'));
    expect(second.embeddings[1]).toEqual(fakeVector('b'));
  });

  it('does not cache across models', async () => {
    const stub = embedStub();
    const client = makeClient(stub);

    await client.embed(['x'], { model: 'turbo' });
    await client.embed(['x'], { model: 'pro' });

    expect(stub.calls).toHaveLength(2);
  });

  it('skips the cache entirely when disabled', async () => {
    const stub = embedStub();
    const client = makeClient(stub, { cache: false });

    await client.embed(['x']);
    await client.embed(['x']);

    expect(stub.calls).toHaveLength(2);
  });

  it('clearCache forces a refetch', async () => {
    const stub = embedStub();
    const client = makeClient(stub);

    await client.embed(['x']);
    client.clearCache();
    await client.embed(['x']);

    expect(stub.calls).toHaveLength(2);
  });

  it('evicts oldest-first once the cache ceiling is reached', async () => {
    const stub = embedStub();
    const client = makeClient(stub, { maxCacheEntries: 2 });

    await client.embed(['one']);
    await client.embed(['two']);
    await client.embed(['three']); // evicts 'one'
    const result = await client.embed(['one']);

    expect(result.cacheHits).toBe(0);
  });
});

describe('input validation', () => {
  it('rejects an empty array', async () => {
    const stub = embedStub();
    await expect(makeClient(stub).embed([])).rejects.toThrow(/non-empty array/);
    expect(stub.calls).toHaveLength(0);
  });

  it.each(['', '   ', '\n\t'])('rejects blank text %j, which the API 502s on', async (text) => {
    const stub = embedStub();

    await expect(makeClient(stub).embed(['ok', text])).rejects.toThrow(/502/);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects a non-string entry', async () => {
    const stub = embedStub();

    await expect(makeClient(stub).embed(['ok', 42 as unknown as string])).rejects.toThrow(
      /texts\[1\] must be a string/,
    );
  });

  it('rejects text over the 32000-character ceiling by default', async () => {
    const stub = embedStub();
    const long = 'x'.repeat(LIMITS.maxCharsPerText + 1);

    await expect(makeClient(stub).embed([long])).rejects.toThrow(VoxellRequestValidationError);
    await expect(makeClient(stub).embed([long])).rejects.toThrow(/413/);
    expect(stub.calls).toHaveLength(0);
  });

  it('truncates oversized text when configured to', async () => {
    const stub = embedStub();
    const long = 'x'.repeat(LIMITS.maxCharsPerText + 500);

    await makeClient(stub, { onOversizedText: 'truncate' }).embed([long]);

    expect(stub.calls[0]!.body.texts![0]!.length).toBe(LIMITS.maxCharsPerText);
  });

  it('accepts text exactly at the limit', async () => {
    const stub = embedStub();
    await expect(
      makeClient(stub).embed(['x'.repeat(LIMITS.maxCharsPerText)]),
    ).resolves.toBeDefined();
  });
});

describe('truncateForEmbedding', () => {
  it('leaves short text untouched', () => {
    expect(truncateForEmbedding('short', 100)).toBe('short');
  });

  it('clips to the limit', () => {
    expect(truncateForEmbedding('abcdef', 3)).toBe('abc');
  });

  it('does not leave a dangling surrogate half', () => {
    // '😀' is a surrogate pair; cutting at 3 would split the second one.
    const text = `ab${'😀'}cd`;
    const clipped = truncateForEmbedding(text, 3);

    expect(clipped).toBe('ab');
    expect([...clipped].every((c) => c.codePointAt(0)! < 0xd800)).toBe(true);
  });
});

describe('error handling', () => {
  it('maps 400 to VoxellBadRequestError and does not retry', async () => {
    const stub = embedStub({
      overrides: [jsonResponse({ error: 'texts must be a non-empty array' }, { status: 400 })],
    });

    await expect(makeClient(stub).embed(['x'])).rejects.toThrow(VoxellBadRequestError);
    expect(stub.calls).toHaveLength(1);
  });

  it('maps 401 to VoxellAuthError', async () => {
    const stub = embedStub({
      overrides: [
        jsonResponse({ error: 'missing or invalid Authorization header' }, { status: 401 }),
      ],
    });

    await expect(makeClient(stub).embed(['x'])).rejects.toThrow(VoxellAuthError);
  });

  it('maps 413 to VoxellPayloadTooLargeError', async () => {
    const stub = embedStub({
      overrides: [jsonResponse({ error: 'Single text exceeds maximum length' }, { status: 413 })],
    });

    await expect(makeClient(stub).embed(['x'])).rejects.toThrow(VoxellPayloadTooLargeError);
  });

  it('explains a Cloudflare 403 rather than blaming the key', async () => {
    const stub = embedStub({ overrides: [jsonResponse('error code: 1010', { status: 403 })] });

    await expect(makeClient(stub).embed(['x'])).rejects.toThrow(/fingerprint was blocked/);
  });

  it('retries a 429 then succeeds', async () => {
    const stub = embedStub({
      overrides: [jsonResponse({ error: 'slow down' }, { status: 429 })],
    });

    const result = await makeClient(stub).embed(['x']);

    expect(stub.calls).toHaveLength(2);
    expect(result.embeddings[0]).toEqual(fakeVector('x'));
  });

  it('retries a 502, which the API returns for transient failures', async () => {
    const stub = embedStub({ overrides: [jsonResponse({ error: 'bad gateway' }, { status: 502 })] });

    await expect(makeClient(stub).embed(['x'])).resolves.toBeDefined();
    expect(stub.calls).toHaveLength(2);
  });

  it('raises a protocol error when embeddings are missing', async () => {
    const stub = embedStub({ overrides: [jsonResponse({ dim: 8, tokens: 1 })] });

    await expect(makeClient(stub).embed(['x'])).rejects.toThrow(/`embeddings` array/);
  });

  it('raises when the API returns the wrong number of vectors', async () => {
    const stub = embedStub({
      overrides: [
        jsonResponse({ dim: 8, embeddings: [fakeVector('x')], latency_ms: 1, model: 'm', tokens: 1 }),
      ],
    });

    await expect(makeClient(stub).embed(['x', 'y'])).rejects.toThrow(
      /returned 1 embeddings for 2 texts/,
    );
  });
});

describe('models', () => {
  it('issues a GET and returns the model list', async () => {
    const stub = embedStub();
    const response = await makeClient(stub).models();

    expect(stub.calls[0]!.method).toBe('GET');
    expect(stub.calls[0]!.url).toBe('https://api.voxell.ai/v1/models');
    expect(response.data[0]!.id).toBe('forge-turbo');
  });
});

describe('dimensionsFor', () => {
  it('reports the measured dimensions per model', () => {
    expect(VoxellClient.dimensionsFor('turbo')).toBe(1024);
    expect(VoxellClient.dimensionsFor('pro')).toBe(2560);
    expect(VoxellClient.dimensionsFor('ultra-4k')).toBe(4096);
  });

  it('maps the OpenAI-named aliases to Voxell dimensions, not OpenAI ones', () => {
    // OpenAI's own text-embedding-3-small is 1536; Voxell's alias is not.
    expect(VoxellClient.dimensionsFor('text-embedding-3-small')).toBe(2560);
  });

  it('returns undefined for an unknown model', () => {
    expect(VoxellClient.dimensionsFor('who-knows')).toBeUndefined();
  });
});

describe('VoxellError', () => {
  it('is the common base for every client error', () => {
    const stub = embedStub({ overrides: [jsonResponse({ error: 'nope' }, { status: 400 })] });

    return expect(makeClient(stub).embed(['x'])).rejects.toBeInstanceOf(VoxellError);
  });
});

describe('riding out an overloaded backend', () => {
  it('keeps asking long enough for a 502 storm to pass', async () => {
    // The real failure: the embeddings edge returned `502` for tens of seconds
    // at a stretch. The old budget was two retries at a 500ms base — about a
    // second and a half of patience — so every run died with paid work already
    // done. Five attempts is what makes the difference; the sleeps between
    // them are stubbed out here, the count is the behaviour.
    const stub = embedStub({
      overrides: Array.from({ length: 4 }, () => new Response('error code: 502\n', { status: 502 })),
    });

    const result = await makeClient(stub).embed(['survives the storm']);

    expect(result.embeddings).toHaveLength(1);
    expect(stub.calls).toHaveLength(5);
  });

  it('waits between attempts rather than hammering a service that is already down', async () => {
    const waits: number[] = [];
    const stub = embedStub({
      overrides: Array.from({ length: 8 }, () => new Response('error code: 502\n', { status: 502 })),
    });

    const client = new VoxellClient({
      apiKey: API_KEY,
      fetch: stub.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(client.embed(['never succeeds'])).rejects.toThrow();

    // Backing off is the whole point: retrying an overloaded backend
    // immediately is what keeps it overloaded.
    expect(waits).toHaveLength(4);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(5_000);
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]!).toBeGreaterThan(waits[i - 1]!);
    }
  });
});

describe('batching by total characters', () => {
  it('splits on the character ceiling, not just the count', async () => {
    const stub = embedStub();
    // 40 texts of 10k chars = 400k, over the 256k ceiling but only 40 items,
    // so a count-only batcher would send them as one request and get a 413.
    const texts = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(9_990)}${String(i).padStart(10, '0')}`);

    await makeClient(stub, { batchSize: 128 }).embed(texts);

    expect(stub.calls.length).toBeGreaterThan(1);
    for (const call of stub.calls) {
      const chars = call.body.texts!.reduce((n: number, t: string) => n + t.length, 0);
      expect(chars).toBeLessThanOrEqual(256_000);
    }
  });

  it('aims well under the ceiling, so a request cannot get slow enough to be killed', async () => {
    const stub = embedStub();
    // 400k characters. Against the 256k ceiling that is two requests, the
    // larger measured at 51.6s — long enough for the edge to time out and
    // return a 502, which is the failure this default exists to avoid.
    const texts = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(9_990)}${String(i).padStart(10, '0')}`);

    await makeClient(stub, { batchSize: 128 }).embed(texts);

    for (const call of stub.calls) {
      const chars = call.body.texts!.reduce((n: number, t: string) => n + t.length, 0);
      expect(chars).toBeLessThanOrEqual(64_000);
    }
    expect(stub.calls.length).toBeGreaterThanOrEqual(7);
  });

  it('lets a caller widen the budget, but never past what the API accepts', async () => {
    const stub = embedStub();
    const texts = Array.from({ length: 60 }, (_, i) => `${'x'.repeat(9_990)}${String(i).padStart(10, '0')}`);

    // 600k requested; the API rejects anything over 256k with a 413, so asking
    // for more must clamp rather than guarantee a failure.
    await makeClient(stub, { batchSize: 128, maxCharsPerBatch: 600_000 }).embed(texts);

    for (const call of stub.calls) {
      const chars = call.body.texts!.reduce((n: number, t: string) => n + t.length, 0);
      expect(chars).toBeLessThanOrEqual(256_000);
    }
    expect(stub.calls.length).toBeGreaterThan(1);
  });

  it('still honours the count limit when the texts are short', async () => {
    const stub = embedStub();
    const texts = Array.from({ length: 250 }, (_, i) => `short ${i}`);

    await makeClient(stub, { batchSize: 100 }).embed(texts);

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.map((c) => c.body.texts!.length)).toEqual([100, 100, 50]);
  });

  it('never strands a text that is itself under the per-text limit', async () => {
    const stub = embedStub();
    // Each is 30k — legal alone, and three of them exceed the batch ceiling.
    const texts = Array.from({ length: 12 }, (_, i) => `${'y'.repeat(29_990)}${String(i).padStart(10, '0')}`);

    const result = await makeClient(stub).embed(texts);

    expect(result.embeddings).toHaveLength(12);
    for (const call of stub.calls) {
      expect(call.body.texts!.length).toBeGreaterThan(0);
      const chars = call.body.texts!.reduce((n: number, t: string) => n + t.length, 0);
      expect(chars).toBeLessThanOrEqual(256_000);
    }
  });

  it('preserves input order across character-split batches', async () => {
    const stub = embedStub();
    const texts = Array.from({ length: 30 }, (_, i) => `${'z'.repeat(9_990)}${String(i).padStart(10, '0')}`);

    const result = await makeClient(stub).embed(texts);

    // `map(fakeVector)` would hand it the index as a second argument.
    expect(result.embeddings).toEqual(texts.map((t) => fakeVector(t)));
  });
});

describe('request pacing', () => {
  it('keeps at most two batches in flight', async () => {
    // The API serialises, so extra concurrency does not parallelise the work —
    // it only makes later requests wait longer before the server reaches them,
    // and it is that wait the timeout measures. Four in flight took the
    // slowest request from 15.6s to 51.6s against a 60s timeout, which is the
    // EmbeddingTimeoutError this guards against.
    let inFlight = 0;
    let peak = 0;

    const fetchStub = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;

      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      return jsonResponse({
        dim: 8,
        embeddings: body.texts.map(fakeVector),
        latency_ms: 1,
        model: 'qwen3-native-28l',
        tokens: body.texts.length,
      });
    };

    const client = new VoxellClient({
      apiKey: API_KEY,
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      batchSize: 1,
    });

    await client.embed(Array.from({ length: 12 }, (_, i) => `text ${i}`));

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(2);
  });

});
