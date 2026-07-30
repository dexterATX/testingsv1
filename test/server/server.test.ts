import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  availableProviders,
  availableWriters,
  parseRunRequest,
  serializeReport,
  startServer,
} from '../../src/server/server.js';
import type { ResearchReport } from '../../src/research/pipeline.js';
import { namesAProvider } from '../../src/server/redact.js';

describe('parseRunRequest', () => {
  it('requires a query', () => {
    expect(() => parseRunRequest({})).toThrow(/`query` is required/);
    expect(() => parseRunRequest({ query: '   ' })).toThrow(/`query` is required/);
  });

  it('rejects an over-long query', () => {
    expect(() => parseRunRequest({ query: 'x'.repeat(2001) })).toThrow(/too long/);
  });

  it('trims the query', () => {
    expect(parseRunRequest({ query: '  hello  ' }).query).toBe('hello');
  });

  it('applies defaults', () => {
    expect(parseRunRequest({ query: 'q' })).toMatchObject({
      numResults: 25,
      chunk: false,
      cluster: true,
      synthesize: false,
      topK: undefined,
    });
  });

  it('clamps numResults into range', () => {
    expect(parseRunRequest({ query: 'q', numResults: 0 }).numResults).toBe(1);
    expect(parseRunRequest({ query: 'q', numResults: 5000 }).numResults).toBe(100);
    expect(parseRunRequest({ query: 'q', numResults: 7 }).numResults).toBe(7);
  });

  it('ignores a non-integer numResults', () => {
    expect(parseRunRequest({ query: 'q', numResults: 'lots' }).numResults).toBe(25);
  });

  it('ignores a non-positive topK', () => {
    expect(parseRunRequest({ query: 'q', topK: 0 }).topK).toBeUndefined();
    expect(parseRunRequest({ query: 'q', topK: -3 }).topK).toBeUndefined();
    expect(parseRunRequest({ query: 'q', topK: 5 }).topK).toBe(5);
  });

  it('maps opaque writer ids back to providers', () => {
    expect(parseRunRequest({ query: 'q', writer: 'writer-a' }).provider).toBe('anthropic');
    expect(parseRunRequest({ query: 'q', writer: 'writer-b' }).provider).toBe('fireworks');
    expect(parseRunRequest({ query: 'q', writer: 'writer-z' }).provider).toBeUndefined();
  });

  it('ignores a provider name sent in place of a writer id', () => {
    // The page has no way to learn these, so a request carrying one is not
    // coming from the UI — and must not select a backend by name.
    expect(parseRunRequest({ query: 'q', writer: 'fireworks' }).provider).toBeUndefined();

    // Not a fresh literal, so the old `provider` field type-checks here.
    const oldShape = { query: 'q', provider: 'fireworks' };
    expect(parseRunRequest(oldShape).provider).toBeUndefined();
  });

  it('treats booleans strictly, so a stray string cannot enable a stage', () => {
    expect(parseRunRequest({ query: 'q', chunk: 'yes' }).chunk).toBe(false);
    expect(parseRunRequest({ query: 'q', synthesize: 1 }).synthesize).toBe(false);
    expect(parseRunRequest({ query: 'q', cluster: false }).cluster).toBe(false);
  });
});

describe('availableProviders', () => {
  it('reflects which keys are set', () => {
    const before = {
      a: process.env['ANTHROPIC_API_KEY'],
      f: process.env['FIREWORKS_API_KEY'],
    };
    try {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['FIREWORKS_API_KEY'];
      expect(availableProviders()).toEqual([]);

      process.env['FIREWORKS_API_KEY'] = 'x';
      expect(availableProviders()).toEqual(['fireworks']);

      process.env['ANTHROPIC_API_KEY'] = 'y';
      expect(availableProviders()).toEqual(['anthropic', 'fireworks']);
    } finally {
      if (before.a === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = before.a;
      if (before.f === undefined) delete process.env['FIREWORKS_API_KEY'];
      else process.env['FIREWORKS_API_KEY'] = before.f;
    }
  });
});

describe('availableWriters', () => {
  const before = {
    a: process.env['ANTHROPIC_API_KEY'],
    f: process.env['FIREWORKS_API_KEY'],
  };

  afterEach(() => {
    if (before.a === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = before.a;
    if (before.f === undefined) delete process.env['FIREWORKS_API_KEY'];
    else process.env['FIREWORKS_API_KEY'] = before.f;
  });

  it('names no provider, in either the id or the label', () => {
    process.env['ANTHROPIC_API_KEY'] = 'x';
    process.env['FIREWORKS_API_KEY'] = 'y';

    const writers = availableWriters();

    expect(writers).toEqual([
      { id: 'writer-a', label: 'Default' },
      { id: 'writer-b', label: 'Alternate' },
    ]);
    expect(namesAProvider(JSON.stringify(writers))).toBe(false);
  });

  it('keeps an id pinned to its provider regardless of which keys are set', () => {
    // A positional id would silently start meaning the other backend here.
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['FIREWORKS_API_KEY'] = 'y';

    expect(availableWriters()).toEqual([{ id: 'writer-b', label: 'Default' }]);
    expect(parseRunRequest({ query: 'q', writer: 'writer-b' }).provider).toBe('fireworks');
  });
});

describe('http server', () => {
  let server: Server;
  let base: string;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(join(tmpdir(), 'webroot-'));
    await writeFile(join(webRoot, 'index.html'), '<h1>ui</h1>', 'utf8');
    await writeFile(join(webRoot, 'app.js'), 'console.log(1)', 'utf8');

    const started = await startServer({ webRoot, port: 0 });
    server = started.server;
    base = started.url;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(webRoot, { recursive: true, force: true });
  });

  it('serves index.html at the root', async () => {
    const response = await fetch(base);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toBe('<h1>ui</h1>');
  });

  it('serves static assets with the right content type', async () => {
    const response = await fetch(`${base}/app.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
  });

  it('404s an unknown path', async () => {
    expect((await fetch(`${base}/nope.css`)).status).toBe(404);
  });

  it('refuses a path traversal attempt', async () => {
    // The web root holds only the UI; nothing above it should be reachable.
    const response = await fetch(`${base}/../../package.json`, { redirect: 'manual' });

    expect(response.status).not.toBe(200);
  });

  it('reports configuration without leaking key material or vendor names', async () => {
    const response = await fetch(`${base}/api/config`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['embeddings', 'search', 'writers']);
    expect(JSON.stringify(body)).not.toMatch(/sk-|fw_|vf_/);
    expect(namesAProvider(JSON.stringify(body))).toBe(false);
  });

  it('rejects a run with no query, before touching any API', async () => {
    const response = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('query'),
    });
  });

  it('rejects a non-GET, non-run method', async () => {
    expect((await fetch(`${base}/`, { method: 'DELETE' })).status).toBe(405);
  });

  it('streams an SSE error frame when a key is missing, rather than hanging', async () => {
    const before = process.env['EXA_API_KEY'];
    delete process.env['EXA_API_KEY'];

    try {
      const response = await fetch(`${base}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'anything', synthesize: false }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/event-stream/);

      const text = await response.text();
      expect(text).toMatch(/^data: /m);

      // The operator's console gets "Missing Exa API key"; the page gets the
      // same fact with the vendor filed off.
      expect(text).toMatch(/Missing search API key/);
      expect(namesAProvider(text)).toBe(false);
    } finally {
      if (before !== undefined) process.env['EXA_API_KEY'] = before;
    }
  });
});

describe('parseRunRequest extraQueries', () => {
  it('accepts extra queries and trims them', () => {
    const config = parseRunRequest({ query: 'main', extraQueries: ['  second  ', 'third'] });

    expect(config.extraQueries).toEqual(['second', 'third']);
  });

  it('drops blanks, non-strings, and a repeat of the main query', () => {
    const config = parseRunRequest({
      query: 'main',
      extraQueries: ['', '   ', 'main', 42, null, 'real'],
    });

    // Re-running the identical search would only pay twice for the same hits.
    expect(config.extraQueries).toEqual(['real']);
  });

  it('caps the fan-out, because each entry is another paid search', () => {
    const many = Array.from({ length: 20 }, (_, i) => `query ${i}`);
    const config = parseRunRequest({ query: 'main', extraQueries: many });

    expect(config.extraQueries).toHaveLength(8);
  });

  it('defaults to none when the field is absent or malformed', () => {
    expect(parseRunRequest({ query: 'main' }).extraQueries).toEqual([]);
    expect(parseRunRequest({ query: 'main', extraQueries: 'not an array' }).extraQueries).toEqual(
      [],
    );
  });
});

describe('serializeReport stats', () => {
  it('forwards demotedByDomain, which the field-by-field copy would drop', () => {
    // serializeReport copies stats explicitly so a name-bearing field added to
    // the pipeline is excluded until opted in. That fail-safe is deliberate,
    // and it means every genuinely wanted new field needs a test like this —
    // demotedByDomain shipped as `undefined` to the browser without one.
    const stats: ResearchReport['stats'] = {
      retrieved: 10, exactDuplicates: 1, embedded: 9, chunks: 9,
      nearDuplicates: 2, demotedByDomain: 3, hydrated: 0, hydrateFailed: 0, belowThreshold: 0,
      dim: 4096, model: 'qwen3-native-36l', tokens: 100, embedLatencyMs: 5, cacheHits: 0,
    };

    const wire = serializeReport({
      query: 'q', results: [], stats, exa: { requestId: 'r', results: [] },
    }) as { stats: Record<string, unknown> };

    expect(wire.stats['demotedByDomain']).toBe(3);
    // And the model name is still withheld.
    expect(wire.stats['model']).toBeUndefined();
  });
});
