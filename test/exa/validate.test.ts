import { describe, expect, it } from 'vitest';

import { ExaRequestValidationError } from '../../src/exa/errors.js';
import {
  assertValidContents,
  assertValidContentsRequest,
  assertValidOutputSchema,
  assertValidSearchRequest,
} from '../../src/exa/validate.js';
import type { JsonSchema, SearchRequest } from '../../src/exa/types.js';

const base: SearchRequest = { query: 'test query' };

/** Asserts the call throws a validation error whose message mentions `needle`. */
function expectRejection(fn: () => void, needle: string | RegExp): void {
  expect(fn).toThrow(ExaRequestValidationError);
  expect(fn).toThrow(needle);
}

describe('assertValidSearchRequest', () => {
  it('accepts the documented default shape', () => {
    expect(() =>
      assertValidSearchRequest({
        query: 'your search query here',
        type: 'auto',
        numResults: 10,
        contents: { highlights: true },
      }),
    ).not.toThrow();
  });

  it('requires a non-empty query', () => {
    expectRejection(() => assertValidSearchRequest({ query: '   ' }), '`query` is required');
    expectRejection(
      () => assertValidSearchRequest({ query: undefined as unknown as string }),
      '`query` is required',
    );
  });

  it('rejects unknown search types', () => {
    expectRejection(
      () => assertValidSearchRequest({ ...base, type: 'neural' as never }),
      /Unknown search type "neural"/,
    );
  });

  it.each([0, 101, 2.5])('rejects numResults=%s', (numResults) => {
    expectRejection(() => assertValidSearchRequest({ ...base, numResults }), /numResults/);
  });

  it.each([1, 10, 100])('accepts numResults=%s', (numResults) => {
    expect(() => assertValidSearchRequest({ ...base, numResults })).not.toThrow();
  });

  describe('content fields nested under contents', () => {
    it.each(['text', 'highlights', 'summary'])('rejects top-level %s on /search', (field) => {
      expectRejection(
        () => assertValidSearchRequest({ ...base, [field]: true } as unknown as SearchRequest),
        /must be nested inside `contents`/,
      );
    });
  });

  describe('deprecated parameters', () => {
    const cases: Array<{ param: string; value: unknown; needle: RegExp }> = [
      { param: 'useAutoprompt', value: true, needle: /deprecated and does nothing/ },
      { param: 'includeUrls', value: ['https://x.com'], needle: /use `includeDomains`/ },
      { param: 'excludeUrls', value: ['https://x.com'], needle: /use `excludeDomains`/ },
      { param: 'numSentences', value: 3, needle: /contents\.highlights/ },
      { param: 'highlightsPerUrl', value: 2, needle: /contents\.highlights/ },
      { param: 'tokensNum', value: 1000, needle: /contents\.text\.maxCharacters/ },
      { param: 'livecrawl', value: 'always', needle: /contents\.maxAgeHours/ },
    ];

    it.each(cases)('rejects $param', ({ param, value, needle }) => {
      expectRejection(
        () => assertValidSearchRequest({ ...base, [param]: value } as unknown as SearchRequest),
        needle,
      );
    });
  });

  describe('category filter restrictions', () => {
    it.each(['company', 'people'] as const)(
      'rejects excludeDomains with category=%s',
      (category) => {
        expectRejection(
          () =>
            assertValidSearchRequest({ ...base, category, excludeDomains: ['spam.com'] }),
          /does not support excludeDomains/,
        );
      },
    );

    it('rejects date filters with category=company', () => {
      expectRejection(
        () =>
          assertValidSearchRequest({
            ...base,
            category: 'company',
            startPublishedDate: '2024-01-01',
          }),
        /does not support startPublishedDate/,
      );
    });

    it('lists every offending filter at once', () => {
      expectRejection(
        () =>
          assertValidSearchRequest({
            ...base,
            category: 'people',
            excludeDomains: ['a.com'],
            startPublishedDate: '2024-01-01',
            endPublishedDate: '2024-02-01',
          }),
        /excludeDomains, startPublishedDate, endPublishedDate/,
      );
    });

    it('allows those filters on other categories', () => {
      expect(() =>
        assertValidSearchRequest({
          ...base,
          category: 'news',
          excludeDomains: ['spam.com'],
          startPublishedDate: '2024-01-01',
        }),
      ).not.toThrow();
    });
  });

  describe('additionalQueries', () => {
    it.each(['deep-lite', 'deep', 'deep-reasoning'] as const)('is allowed on %s', (type) => {
      expect(() =>
        assertValidSearchRequest({ ...base, type, additionalQueries: ['angle one'] }),
      ).not.toThrow();
    });

    it.each(['auto', 'fast', 'instant'] as const)('is rejected on %s', (type) => {
      expectRejection(
        () => assertValidSearchRequest({ ...base, type, additionalQueries: ['angle one'] }),
        /only supported on the deep search types/,
      );
    });

    it('is rejected when type is omitted, since the default is auto', () => {
      expectRejection(
        () => assertValidSearchRequest({ ...base, additionalQueries: ['angle'] }),
        /but type is "auto"/,
      );
    });

    it('ignores an empty additionalQueries array', () => {
      expect(() =>
        assertValidSearchRequest({ ...base, type: 'auto', additionalQueries: [] }),
      ).not.toThrow();
    });
  });

  it('rejects domain lists longer than 1200 entries', () => {
    const domains = Array.from({ length: 1201 }, (_, i) => `site${i}.com`);
    expectRejection(
      () => assertValidSearchRequest({ ...base, includeDomains: domains }),
      /at most 1200 entries/,
    );
  });

  it.each(['USA', 'u', '12'])('rejects userLocation=%s', (userLocation) => {
    expectRejection(
      () => assertValidSearchRequest({ ...base, userLocation }),
      /two-letter ISO country code/,
    );
  });

  it('accepts a two-letter userLocation', () => {
    expect(() => assertValidSearchRequest({ ...base, userLocation: 'US' })).not.toThrow();
  });
});

describe('assertValidOutputSchema', () => {
  it('accepts the documented companies example', () => {
    const schema: JsonSchema = {
      type: 'object',
      description: 'Companies mentioned in articles',
      required: ['companies'],
      properties: {
        companies: {
          type: 'array',
          description: 'List of companies mentioned',
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'Name of the company' },
              description: { type: 'string', description: 'What the company does' },
            },
          },
        },
      },
    };

    expect(() => assertValidOutputSchema(schema)).not.toThrow();
  });

  it('rejects nesting deeper than two levels', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: { type: 'object', properties: { c: { type: 'string' } } },
          },
        },
      },
    };

    expectRejection(() => assertValidOutputSchema(schema), /maximum nesting depth of 2/);
  });

  it('rejects more than ten total properties', () => {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 11; i += 1) properties[`field${i}`] = { type: 'string' };

    expectRejection(
      () => assertValidOutputSchema({ type: 'object', properties }),
      /declares 11 properties/,
    );
  });

  it('counts properties across nested objects', () => {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 6; i += 1) properties[`nested${i}`] = { type: 'string' };

    const schema: JsonSchema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
        d: { type: 'string' },
        e: { type: 'object', properties },
      },
    };

    expectRejection(() => assertValidOutputSchema(schema), /declares 11 properties/);
  });

  it('accepts a plain text schema', () => {
    expect(() => assertValidOutputSchema({ type: 'string' })).not.toThrow();
  });
});

describe('assertValidContents', () => {
  it.each([-1, 0, 1, 24, 720])('accepts maxAgeHours=%s', (maxAgeHours) => {
    expect(() => assertValidContents({ maxAgeHours })).not.toThrow();
  });

  it.each([-2, 721, 1.5])('rejects maxAgeHours=%s', (maxAgeHours) => {
    expectRejection(() => assertValidContents({ maxAgeHours }), /maxAgeHours/);
  });

  it('rejects a snake_case maxCharacters, which silently does nothing in JSON', () => {
    expectRejection(
      () => assertValidContents({ text: { max_characters: 20000 } as never }),
      /snake_case/,
    );
  });

  it('rejects an out-of-range livecrawlTimeout', () => {
    expectRejection(() => assertValidContents({ livecrawlTimeout: 90_001 }), /livecrawlTimeout/);
  });

  it('rejects an out-of-range subpages count', () => {
    expectRejection(() => assertValidContents({ subpages: 101 }), /subpages/);
  });

  it('validates a summary schema against the outputSchema limits', () => {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 11; i += 1) properties[`f${i}`] = { type: 'string' };

    expectRejection(
      () => assertValidContents({ summary: { schema: { type: 'object', properties } } }),
      /declares 11 properties/,
    );
  });

  it('accepts boolean shorthands', () => {
    expect(() =>
      assertValidContents({ text: true, highlights: true, summary: true }),
    ).not.toThrow();
  });
});

describe('assertValidContentsRequest', () => {
  it('requires a non-empty urls array', () => {
    expectRejection(() => assertValidContentsRequest([]), /non-empty array/);
  });

  it('rejects more than 100 urls', () => {
    const urls = Array.from({ length: 101 }, (_, i) => `https://example.com/${i}`);
    expectRejection(() => assertValidContentsRequest(urls), /at most 100 entries/);
  });

  it('rejects blank entries', () => {
    expectRejection(
      () => assertValidContentsRequest(['https://example.com', '  ']),
      /non-empty string/,
    );
  });

  it('accepts a valid request', () => {
    expect(() =>
      assertValidContentsRequest(['https://example.com/article'], { highlights: true }),
    ).not.toThrow();
  });
});
