/**
 * Live tests against the real Exa API.
 *
 * Opt-in: skipped unless `EXA_LIVE_TEST=1` and `EXA_API_KEY` are both set.
 *
 *   EXA_LIVE_TEST=1 npm run test:live
 *
 * These exist because several rules in Exa's own setup guide turned out not to
 * match the live API. Each divergence below is asserted here so that if Exa
 * changes behavior — in either direction — this suite says so rather than the
 * client silently drifting out of sync.
 *
 * Some assertions bypass `ExaClient` and use raw `fetch`, deliberately: they
 * verify what the *API* does, which is exactly what the client's validation
 * would otherwise prevent us from observing.
 */

import { describe, expect, it, vi } from 'vitest';

import { ExaClient } from '../../src/exa/client.js';
import { ExaBadRequestError, ExaRequestValidationError } from '../../src/exa/errors.js';

vi.setConfig({ testTimeout: 90_000 });

const apiKey = process.env['EXA_API_KEY'];
const enabled = process.env['EXA_LIVE_TEST'] === '1' && Boolean(apiKey);

const client = (): ExaClient => new ExaClient({ maxRetries: 1 });

/** Raw call that skips client-side validation, to observe the API directly. */
async function raw(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`https://api.exa.ai${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey as string, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe.skipIf(!enabled)('Exa live API', () => {
  it('authenticates with the x-api-key header and returns results', async () => {
    const response = await client().search('semantic search relevance', {
      type: 'fast',
      numResults: 3,
      contents: { highlights: true },
    });

    expect(response.results).toHaveLength(3);
    expect(response.requestId).toBeTruthy();
    expect(response.results[0]!.url).toMatch(/^https?:\/\//);
    expect(response.results[0]!.highlights?.length).toBeGreaterThan(0);
  });

  it('returns resolvedSearchType and searchTime, not the documented searchType', async () => {
    // The docs describe `searchType`; the live API sends `resolvedSearchType`
    // plus an undocumented `searchTime`. The client types both.
    const { body } = await raw('/search', { query: 'vector database', type: 'fast', numResults: 1 });

    expect(body).toHaveProperty('resolvedSearchType');
    expect(body).toHaveProperty('searchTime');
    expect(body).not.toHaveProperty('searchType');
  });

  it('reports cost on every search', async () => {
    const response = await client().search('vector database', { type: 'fast', numResults: 1 });

    expect(response.costDollars?.total).toBeGreaterThan(0);
  });

  describe('category filter matrix', () => {
    it('accepts company + excludeDomains, despite the docs grouping it with people', async () => {
      const { status } = await raw('/search', {
        query: 'ai infrastructure startups',
        type: 'fast',
        numResults: 1,
        category: 'company',
        excludeDomains: ['spam.example.com'],
      });

      expect(status).toBe(200);
    });

    it('the client allows that combination too', async () => {
      await expect(
        client().search('ai infrastructure startups', {
          type: 'fast',
          numResults: 1,
          category: 'company',
          excludeDomains: ['spam.example.com'],
        }),
      ).resolves.toBeDefined();
    });

    it('rejects people + excludeDomains with a 400', async () => {
      const { status, body } = await raw('/search', {
        query: 'machine learning researchers',
        type: 'fast',
        numResults: 1,
        category: 'people',
        excludeDomains: ['spam.example.com'],
      });

      expect(status).toBe(400);
      expect(String(body['error'])).toMatch(/people category does not support/i);
    });

    it.each(['company', 'people'])('rejects %s + startPublishedDate with a 400', async (category) => {
      const { status, body } = await raw('/search', {
        query: 'technology',
        type: 'fast',
        numResults: 1,
        category,
        startPublishedDate: '2024-01-01',
      });

      expect(status).toBe(400);
      expect(String(body['error'])).toMatch(/does not support/i);
    });

    it('the client blocks the combinations the API rejects, without a round trip', async () => {
      await expect(
        client().search('x', { category: 'people', excludeDomains: ['a.com'] }),
      ).rejects.toThrow(ExaRequestValidationError);
      await expect(
        client().search('x', { category: 'company', startPublishedDate: '2024-01-01' }),
      ).rejects.toThrow(ExaRequestValidationError);
    });
  });

  it('accepts additionalQueries on a non-deep type', async () => {
    // The guide calls this deep-types-only. The API accepts it on `auto` and
    // returns normal results, which is why the client no longer rejects it.
    //
    // Whether it *changes* the result set is not asserted: it demonstrably can
    // (observed during calibration), but Exa's ranking varies between
    // identical calls, so an inequality assertion here would be flaky.
    const steered = await client().search('vector database', {
      type: 'auto',
      numResults: 5,
      additionalQueries: ['approximate nearest neighbour libraries', 'HNSW index tuning'],
    });

    expect(steered.results.length).toBeGreaterThan(0);
    expect(steered.costDollars?.total).toBeGreaterThan(0);
  });

  it('silently ignores content fields at the top level, which is why the client rejects them', async () => {
    const nested = await raw('/search', {
      query: 'vector database',
      type: 'fast',
      numResults: 1,
      contents: { highlights: true },
    });
    const topLevel = await raw('/search', {
      query: 'vector database',
      type: 'fast',
      numResults: 1,
      highlights: true,
    });

    const first = (r: typeof nested) => (r.body['results'] as Array<Record<string, unknown>>)[0]!;

    expect(first(nested)).toHaveProperty('highlights');
    expect(first(topLevel)).not.toHaveProperty('highlights');

    // Which is the whole justification for the client-side rejection.
    await expect(
      client().search('x', { highlights: true } as never),
    ).rejects.toThrow(/must be nested inside `contents`/);
  });

  it('accepts unknown parameters silently, which is why removed ones are rejected locally', async () => {
    const { status } = await raw('/search', {
      query: 'vector database',
      type: 'fast',
      numResults: 1,
      useAutoprompt: true,
      totallyMadeUpParameter: 'xyz',
    });

    expect(status).toBe(200);
    await expect(
      client().search('x', { useAutoprompt: true } as never),
    ).rejects.toThrow(/not a supported parameter/);
  });

  it('caps numResults by plan rather than at a fixed 100', async () => {
    const { status, body } = await raw('/search', {
      query: 'vector database',
      type: 'fast',
      numResults: 100_000,
    });

    expect(status).toBe(400);
    expect(String(body['error'])).toMatch(/plan allows/i);

    // So the client must not impose its own ceiling.
    await expect(
      client().search('vector database', { type: 'fast', numResults: 100 }),
    ).resolves.toBeDefined();
  });

  it('maps a real 400 onto ExaBadRequestError with a requestId', async () => {
    // Bypass the client guard by casting, so the API produces the error.
    await expect(
      client().search('technology', {
        type: 'fast',
        numResults: 1,
        category: 'people',
        endPublishedDate: '2025-01-01',
      } as never),
    ).rejects.toThrow(ExaRequestValidationError);

    // And a genuinely server-side rejection maps correctly.
    const badKey = new ExaClient({ apiKey: 'not-a-real-key', maxRetries: 0 });
    await expect(badKey.search('x', { type: 'fast', numResults: 1 })).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('returns grounded structured output from outputSchema on a non-deep type', async () => {
    const response = await client().search<{ companies: string[] }>('articles about GPUs', {
      type: 'auto',
      numResults: 3,
      contents: { highlights: true },
      outputSchema: {
        type: 'object',
        required: ['companies'],
        properties: {
          companies: {
            type: 'array',
            description: 'companies mentioned',
            items: { type: 'string' },
          },
        },
      },
    });

    expect(response.output?.content.companies.length).toBeGreaterThan(0);
    expect(response.output?.grounding.length).toBeGreaterThan(0);
    expect(response.output?.grounding[0]!.citations[0]!.url).toMatch(/^https?:\/\//);
  });

  describe('/contents', () => {
    it('returns content and a success status for a known URL', async () => {
      const response = await client().contents(['https://arxiv.org/abs/2307.06435'], {
        highlights: true,
      });

      expect(response.results).toHaveLength(1);
      expect(response.statuses?.[0]).toMatchObject({ status: 'success' });
    });

    it('reports an unreachable URL in statuses rather than throwing', async () => {
      const response = await client().contents(['https://example.invalid/nope']);

      expect(response.results).toHaveLength(0);
      expect(response.statuses?.[0]!.status).toBe('error');
      expect(response.statuses?.[0]!.error?.tag).toBeTruthy();
    });
  });

  it('/answer returns prose with citations', async () => {
    const response = await client().answer('What is the capital of France?');

    expect(String(response.answer)).toMatch(/Paris/i);
    expect(response.citations.length).toBeGreaterThan(0);
    expect(response.citations[0]!.url).toMatch(/^https?:\/\//);
  });
});
