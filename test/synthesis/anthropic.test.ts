import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SYNTHESIS_MODEL, anthropicCompleter } from '../../src/synthesis/anthropic.js';
import { SynthesisError, SynthesisRefusedError } from '../../src/synthesis/types.js';

interface StubOptions {
  response?: unknown;
  error?: unknown;
}

/** A stand-in for the SDK client, recording the params it was called with. */
function stubClient(options: StubOptions = {}) {
  const calls: Array<Record<string, unknown>> = [];

  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          if (options.error) throw options.error;
          return (
            options.response ?? {
              model: DEFAULT_SYNTHESIS_MODEL,
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'synthesized answer' }],
              usage: { input_tokens: 100, output_tokens: 50 },
            }
          );
        },
      },
    },
  };

  return { client: client as unknown as Anthropic, calls };
}

const request = { system: 'sys', prompt: 'prompt', maxTokens: 1000 };

describe('anthropicCompleter', () => {
  it('defaults to claude-opus-5', async () => {
    const { client, calls } = stubClient();

    await anthropicCompleter({ client })(request);

    expect(calls[0]!['model']).toBe('claude-opus-5');
  });

  it('sends the system prompt and user message', async () => {
    const { client, calls } = stubClient();

    await anthropicCompleter({ client })(request);

    expect(calls[0]!['system']).toBe('sys');
    expect(calls[0]!['messages']).toEqual([{ role: 'user', content: 'prompt' }]);
  });

  it('opts into server-side fallbacks by default', async () => {
    const { client, calls } = stubClient();

    await anthropicCompleter({ client })(request);

    expect(calls[0]!['fallbacks']).toBe('default');
    expect(calls[0]!['betas']).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('can disable fallbacks', async () => {
    const { client, calls } = stubClient();

    await anthropicCompleter({ client, fallbacks: false })(request);

    expect(calls[0]).not.toHaveProperty('fallbacks');
    expect(calls[0]).not.toHaveProperty('betas');
  });

  it('defaults effort to high and honors an override', async () => {
    const { client, calls } = stubClient();

    await anthropicCompleter({ client })(request);
    expect(calls[0]!['output_config']).toEqual({ effort: 'high' });

    await anthropicCompleter({ client, effort: 'max' })(request);
    expect(calls[1]!['output_config']).toEqual({ effort: 'max' });
  });

  it('uses the request max_tokens, falling back to the client default', async () => {
    const { client, calls } = stubClient();

    await anthropicCompleter({ client })(request);
    expect(calls[0]!['max_tokens']).toBe(1000);

    await anthropicCompleter({ client, maxTokens: 4242 })({ ...request, maxTokens: 0 });
    expect(calls[1]!['max_tokens']).toBe(4242);
  });

  it('concatenates text blocks and ignores non-text blocks', async () => {
    const { client } = stubClient({
      response: {
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });

    const result = await anthropicCompleter({ client })(request);

    expect(result.text).toBe('part one part two');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  describe('refusals', () => {
    it('raises rather than returning empty content', async () => {
      // A refusal is an HTTP 200 with empty content — the trap this guards.
      const { client } = stubClient({
        response: {
          model: 'claude-opus-5',
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber' },
          content: [],
          usage: {},
        },
      });

      await expect(anthropicCompleter({ client })(request)).rejects.toThrow(
        SynthesisRefusedError,
      );
    });

    it('carries the refusal category', async () => {
      const { client } = stubClient({
        response: {
          model: 'claude-opus-5',
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'bio' },
          content: [],
          usage: {},
        },
      });

      await expect(anthropicCompleter({ client })(request)).rejects.toMatchObject({
        category: 'bio',
      });
    });

    it('handles a refusal with no stop_details', async () => {
      const { client } = stubClient({
        response: {
          model: 'claude-opus-5',
          stop_reason: 'refusal',
          stop_details: null,
          content: [],
          usage: {},
        },
      });

      await expect(anthropicCompleter({ client })(request)).rejects.toThrow(
        SynthesisRefusedError,
      );
    });
  });

  describe('error mapping', () => {
    it('explains a missing key on an auth error', async () => {
      const error = Object.create(Anthropic.AuthenticationError.prototype) as Error;
      Object.assign(error, { status: 401, message: 'invalid x-api-key' });
      const { client } = stubClient({ error });

      await expect(anthropicCompleter({ client })(request)).rejects.toThrow(
        /ANTHROPIC_API_KEY/,
      );
    });

    it('wraps a rate limit error', async () => {
      const error = Object.create(Anthropic.RateLimitError.prototype) as Error;
      Object.assign(error, { status: 429, message: 'slow down' });
      const { client } = stubClient({ error });

      await expect(anthropicCompleter({ client })(request)).rejects.toThrow(
        /rate limited: slow down/,
      );
    });

    it('wraps a generic API error with its status', async () => {
      const error = Object.create(Anthropic.APIError.prototype) as Error;
      Object.assign(error, { status: 500, message: 'boom' });
      const { client } = stubClient({ error });

      await expect(anthropicCompleter({ client })(request)).rejects.toThrow(
        /Claude API error 500: boom/,
      );
    });

    it('rethrows a non-API error unchanged', async () => {
      const { client } = stubClient({ error: new TypeError('something else') });

      await expect(anthropicCompleter({ client })(request)).rejects.toThrow(TypeError);
    });

    it('wraps API errors as SynthesisError', async () => {
      const error = Object.create(Anthropic.APIError.prototype) as Error;
      Object.assign(error, { status: 503, message: 'unavailable' });
      const { client } = stubClient({ error });

      await expect(anthropicCompleter({ client })(request)).rejects.toBeInstanceOf(
        SynthesisError,
      );
    });
  });
});
