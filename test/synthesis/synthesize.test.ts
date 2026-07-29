import { describe, expect, it, vi } from 'vitest';

import { SynthesisError, type Completer } from '../../src/synthesis/types.js';
import { extractCitationMarkers, synthesize } from '../../src/synthesis/synthesize.js';
import type { RankedResult, ResearchReport } from '../../src/research/pipeline.js';

function makeResult(overrides: Partial<RankedResult> = {}): RankedResult {
  return {
    result: {
      id: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Example A',
      highlights: ['an excerpt'],
    },
    score: 0.9,
    originalRank: 0,
    rankDelta: 0,
    duplicates: [],
    embeddedText: 'Example A\n\nan excerpt',
    ...overrides,
  };
}

function makeReport(results: RankedResult[], query = 'the research question'): ResearchReport {
  return {
    query,
    results,
    stats: {
      retrieved: results.length,
      exactDuplicates: 0,
      embedded: results.length + 1,
      chunks: results.length,
      nearDuplicates: 0,
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

/** A completer that returns fixed text and records what it was asked. */
function stubCompleter(text: string) {
  const calls: Array<{ system: string; prompt: string; maxTokens: number }> = [];
  const completer: Completer = async (request) => {
    calls.push({
      system: request.system,
      prompt: request.prompt,
      maxTokens: request.maxTokens,
    });
    return { text, model: 'claude-opus-5', stopReason: 'end_turn' };
  };
  return { completer, calls };
}

describe('extractCitationMarkers', () => {
  it('finds single markers', () => {
    expect(extractCitationMarkers('a claim [1] and another [3].')).toEqual([1, 3]);
  });

  it('finds grouped markers', () => {
    expect(extractCitationMarkers('both agree [2,3] here.')).toEqual([2, 3]);
    expect(extractCitationMarkers('spaced [1, 4].')).toEqual([1, 4]);
  });

  it('deduplicates and sorts', () => {
    expect(extractCitationMarkers('[3] then [1] then [3] again')).toEqual([1, 3]);
  });

  it('ignores non-numeric brackets', () => {
    expect(extractCitationMarkers('an [aside] and [see also]')).toEqual([]);
  });

  it('returns nothing for uncited text', () => {
    expect(extractCitationMarkers('no citations at all')).toEqual([]);
  });
});

describe('synthesize', () => {
  it('returns the write-up and maps sources to markers', async () => {
    const { completer } = stubCompleter('Answer grounded in evidence [1] and [2].');
    const report = makeReport([
      makeResult({ result: { id: '1', url: 'https://a.com', title: 'A' } }),
      makeResult({ result: { id: '2', url: 'https://b.com', title: 'B' } }),
    ]);

    const synthesis = await synthesize(report, { completer });

    expect(synthesis.text).toContain('[1]');
    expect(synthesis.query).toBe('the research question');
    expect(synthesis.sources.map((s) => s.marker)).toEqual([1, 2]);
    expect(synthesis.sources.every((s) => s.cited)).toBe(true);
    expect(synthesis.model).toBe('claude-opus-5');
  });

  it('flags a fabricated citation', async () => {
    // Only two sources exist, but the model cited a third.
    const { completer } = stubCompleter('Claim [1], another [7].');
    const report = makeReport([makeResult(), makeResult()]);

    const synthesis = await synthesize(report, { completer });

    expect(synthesis.invalidMarkers).toEqual([7]);
  });

  it('reports sources the write-up never cited', async () => {
    const { completer } = stubCompleter('Only the first mattered [1].');
    const report = makeReport([makeResult(), makeResult(), makeResult()]);

    const synthesis = await synthesize(report, { completer });

    expect(synthesis.uncitedMarkers).toEqual([2, 3]);
    expect(synthesis.sources[0]!.cited).toBe(true);
    expect(synthesis.sources[1]!.cited).toBe(false);
  });

  it('has no invalid markers when the write-up is clean', async () => {
    const { completer } = stubCompleter('Grounded [1][2].');
    const report = makeReport([makeResult(), makeResult()]);

    const synthesis = await synthesize(report, { completer });

    expect(synthesis.invalidMarkers).toEqual([]);
    expect(synthesis.uncitedMarkers).toEqual([]);
  });

  it('numbers sources from 1 in the prompt', async () => {
    const { completer, calls } = stubCompleter('ok');
    const report = makeReport([
      makeResult({ result: { id: '1', url: 'https://a.com', title: 'First' } }),
      makeResult({ result: { id: '2', url: 'https://b.com', title: 'Second' } }),
    ]);

    await synthesize(report, { completer });

    expect(calls[0]!.prompt).toContain('[1] First');
    expect(calls[0]!.prompt).toContain('[2] Second');
    expect(calls[0]!.prompt).toContain('https://a.com');
  });

  it('includes the question in the prompt', async () => {
    const { completer, calls } = stubCompleter('ok');

    await synthesize(makeReport([makeResult()], 'what changed in v3?'), { completer });

    expect(calls[0]!.prompt).toContain('what changed in v3?');
  });

  it('prefers the best chunk as evidence when chunking ran', async () => {
    const { completer, calls } = stubCompleter('ok');
    const report = makeReport([
      makeResult({
        embeddedText: 'the whole long document',
        bestChunk: { text: 'the relevant passage', index: 3, score: 0.8 },
      }),
    ]);

    await synthesize(report, { completer });

    expect(calls[0]!.prompt).toContain('the relevant passage');
    expect(calls[0]!.prompt).not.toContain('the whole long document');
  });

  it('caps evidence length', async () => {
    const { completer, calls } = stubCompleter('ok');
    const report = makeReport([makeResult({ embeddedText: 'x'.repeat(5000) })]);

    await synthesize(report, { completer, evidenceChars: 100 });

    expect(calls[0]!.prompt).not.toContain('x'.repeat(101));
  });

  it('limits sources with maxSources', async () => {
    const { completer, calls } = stubCompleter('ok');
    const report = makeReport([makeResult(), makeResult(), makeResult()]);

    const synthesis = await synthesize(report, { completer, maxSources: 2 });

    expect(synthesis.sources).toHaveLength(2);
    expect(calls[0]!.prompt).not.toContain('[3]');
  });

  it('mentions duplicate coverage, which signals corroboration', async () => {
    const { completer, calls } = stubCompleter('ok');
    const report = makeReport([
      makeResult({
        duplicates: [
          { result: { id: 'x', url: 'https://x.com', title: 'X' }, similarity: 0.95 },
        ],
      }),
    ]);

    await synthesize(report, { completer });

    expect(calls[0]!.prompt).toMatch(/Also reported by 1 other source/);
  });

  it('appends caller guidance to the system prompt', async () => {
    const { completer, calls } = stubCompleter('ok');

    await synthesize(makeReport([makeResult()]), {
      completer,
      guidance: 'Write for a non-technical reader.',
    });

    expect(calls[0]!.system).toContain('Write for a non-technical reader.');
    expect(calls[0]!.system).toContain('research analyst');
  });

  it('instructs the model not to invent sources', async () => {
    const { completer, calls } = stubCompleter('ok');

    await synthesize(makeReport([makeResult()]), { completer });

    expect(calls[0]!.system).toMatch(/Never cite a number that is not in the list/);
  });

  it('throws rather than calling the model on an empty report', async () => {
    const completer = vi.fn();

    await expect(
      synthesize(makeReport([]), { completer: completer as unknown as Completer }),
    ).rejects.toThrow(SynthesisError);
    expect(completer).not.toHaveBeenCalled();
  });

  it('propagates a completer failure', async () => {
    const completer: Completer = async () => {
      throw new SynthesisError('upstream exploded');
    };

    await expect(synthesize(makeReport([makeResult()]), { completer })).rejects.toThrow(
      /upstream exploded/,
    );
  });

  it('forwards the abort signal', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const completer: Completer = async (request) => {
      seen = request.signal;
      return { text: 'ok' };
    };

    await synthesize(makeReport([makeResult()]), { completer, signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });
});
