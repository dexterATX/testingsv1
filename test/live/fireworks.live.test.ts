/**
 * Live tests against the real Fireworks API.
 *
 * Opt-in: skipped unless `FIREWORKS_LIVE_TEST=1` and `FIREWORKS_API_KEY` are
 * both set.
 *
 *   FIREWORKS_LIVE_TEST=1 npm run test:live
 *
 * Fireworks is the one synthesis provider with a working key here, so this is
 * also where the synthesis path is verified end to end rather than stubbed.
 */

import { describe, expect, it, vi } from 'vitest';

import { FireworksClient } from '../../src/fireworks/client.js';
import {
  FireworksAuthError,
  FireworksModelNotFoundError,
  FireworksRequestValidationError,
} from '../../src/fireworks/errors.js';
import { fireworksCompleter } from '../../src/synthesis/fireworks.js';
import { synthesize } from '../../src/synthesis/synthesize.js';
import type { ResearchReport, RankedResult } from '../../src/research/pipeline.js';

vi.setConfig({ testTimeout: 180_000 });

const enabled =
  process.env['FIREWORKS_LIVE_TEST'] === '1' && Boolean(process.env['FIREWORKS_API_KEY']);

const client = (): FireworksClient => new FireworksClient({ maxRetries: 1 });

describe.skipIf(!enabled)('Fireworks live API', () => {
  it('completes a chat with a Bearer token and returns usage', async () => {
    const result = await client().chat([{ role: 'user', content: 'Reply with exactly: OK' }], {
      maxTokens: 256,
    });

    expect(result.text.trim()).toContain('OK');
    expect(result.model).toContain('kimi-k3');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('honors a system prompt', async () => {
    const result = await client().chat(
      [
        { role: 'system', content: 'You always answer in exactly one word.' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      { maxTokens: 512 },
    );

    expect(result.text.trim()).toMatch(/^Paris\.?$/i);
  });

  it('returns reasoning separately from the answer, and bills it as output', async () => {
    // kimi-k3 is a reasoning model: the trace lands in `reasoning_content`,
    // and its tokens are counted inside completion_tokens — so a two-word
    // answer can cost far more than its length implies.
    const result = await client().chat(
      [{ role: 'user', content: 'What is 17 * 23? Think it through, then give the number.' }],
      { maxTokens: 1024 },
    );

    expect(result.text).toContain('391');
    expect(result.reasoning).toBeTruthy();
    expect(result.usage.completionTokens).toBeGreaterThan(result.text.length / 4);
  });

  it('lists models, including the default', async () => {
    const { data } = await client().models();
    const ids = data.map((m) => m.id);

    expect(ids).toContain('accounts/fireworks/models/kimi-k3');
    expect(ids.length).toBeGreaterThan(5);
  });

  it('constrains output to JSON with response_format', async () => {
    const result = await client().chat(
      [{ role: 'user', content: 'Return JSON with a single key "ok" set to true.' }],
      { maxTokens: 1024, responseFormat: 'json_object' },
    );

    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  describe('the traps this client guards', () => {
    it('rejects maxTokens 0 locally — the API returns 200 with empty content', async () => {
      await expect(
        client().chat([{ role: 'user', content: 'hi' }], { maxTokens: 0 }),
      ).rejects.toThrow(FireworksRequestValidationError);
    });

    it('treats a truncated reply as a failure by default', async () => {
      await expect(
        client().chat([{ role: 'user', content: 'Write three paragraphs about the ocean.' }], {
          maxTokens: 12,
        }),
      ).rejects.toThrow(/truncated/);
    });

    it('returns the partial reply when truncation is explicitly allowed', async () => {
      const result = await client().chat(
        [{ role: 'user', content: 'Write three paragraphs about the ocean.' }],
        { maxTokens: 12, failOnTruncation: false },
      );

      expect(result.finishReason).toBe('length');
    });
  });

  describe('errors', () => {
    it('maps an unknown model to FireworksModelNotFoundError', async () => {
      await expect(
        client().chat([{ role: 'user', content: 'hi' }], {
          model: 'accounts/fireworks/models/does-not-exist',
          maxTokens: 32,
        }),
      ).rejects.toThrow(FireworksModelNotFoundError);
    });

    it('maps an invalid key to FireworksAuthError', async () => {
      const bad = new FireworksClient({ apiKey: 'fw_totally-invalid', maxRetries: 0 });

      await expect(
        bad.chat([{ role: 'user', content: 'hi' }], { maxTokens: 32 }),
      ).rejects.toThrow(FireworksAuthError);
    });
  });
});

/** A minimal report so synthesis can be exercised without spending on search. */
function report(): ResearchReport {
  const make = (title: string, url: string, text: string): RankedResult => ({
    result: { id: url, url, title },
    score: 0.8,
    originalRank: 0,
    rankDelta: 0,
    duplicates: [],
    embeddedText: `${title}\n\n${text}`,
  });

  return {
    query: 'what metrics do teams use to evaluate RAG retrieval quality?',
    results: [
      make(
        'Golden datasets for RAG retrieval',
        'https://example.com/golden',
        'Teams build curated golden datasets of question and passage pairs, then measure recall at k and mean reciprocal rank on every change to the retrieval stage.',
      ),
      make(
        'Chunking and embedding quality',
        'https://example.com/chunking',
        'Splitting documents on semantic boundaries rather than fixed token counts measurably improves retrieval, and overlapping windows preserve context across boundaries.',
      ),
    ],
    stats: {
      retrieved: 2,
      exactDuplicates: 0,
      embedded: 3,
      chunks: 2,
      nearDuplicates: 0,
      demotedByDomain: 0,
      belowThreshold: 0,
      dim: 1024,
      model: 'qwen3-native-28l',
      tokens: 100,
      embedLatencyMs: 10,
      cacheHits: 0,
    },
    exa: { requestId: 'req', results: [] },
  };
}

describe.skipIf(!enabled)('synthesis against live Fireworks', () => {
  it('produces a grounded write-up whose citations all resolve', async () => {
    const synthesis = await synthesize(report(), {
      completer: fireworksCompleter({ maxRetries: 1 }),
      maxTokens: 4_000,
    });

    expect(synthesis.text.length).toBeGreaterThan(200);
    expect(synthesis.model).toContain('kimi-k3');

    // The property that makes the write-up trustworthy: every marker the model
    // emitted maps to a real source.
    expect(synthesis.invalidMarkers).toEqual([]);

    // And it actually cited — an uncited write-up would be ungrounded prose.
    expect(synthesis.sources.some((s) => s.cited)).toBe(true);
    expect(synthesis.text).toMatch(/\[\d+/);
  });

  it('reports a source the write-up ignored', async () => {
    const single = report();
    single.results.push({
      result: {
        id: 'https://example.com/unrelated',
        url: 'https://example.com/unrelated',
        title: 'Sourdough starter maintenance',
      },
      score: 0.1,
      originalRank: 2,
      rankDelta: 0,
      duplicates: [],
      embeddedText: 'Feed the starter twice daily with equal parts flour and water.',
    });

    const synthesis = await synthesize(single, {
      completer: fireworksCompleter({ maxRetries: 1 }),
      maxTokens: 4_000,
    });

    expect(synthesis.invalidMarkers).toEqual([]);

    // Assert the *bookkeeping*, not the model's judgement.
    //
    // This used to assert that marker 3 — the bread page — went uncited, which
    // is a bet on what the model chooses to do: measured over repeated runs it
    // failed roughly one time in three, because sometimes it cites the
    // off-topic source anyway. A live test that flips a coin teaches nobody
    // anything. What must hold every time is that `uncitedMarkers` agrees with
    // the text, and that is entirely our code.
    const appears = (marker: number): boolean =>
      new RegExp(`\\[[^\\]]*\\b${marker}\\b[^\\]]*\\]`).test(synthesis.text);

    for (const source of synthesis.sources) {
      expect(source.cited, `source ${source.marker} cited flag`).toBe(appears(source.marker));
      expect(
        synthesis.uncitedMarkers.includes(source.marker),
        `source ${source.marker} in uncitedMarkers`,
      ).toBe(!appears(source.marker));
    }

    // The off-topic source was offered, so it is either cited or reported as
    // ignored — never silently dropped from the accounting.
    expect(synthesis.sources.map((s) => s.marker)).toContain(3);
  });
});
