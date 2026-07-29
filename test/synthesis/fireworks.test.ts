import { describe, expect, it } from 'vitest';

import { FireworksClient } from '../../src/fireworks/client.js';
import { fireworksCompleter } from '../../src/synthesis/fireworks.js';

interface Recorded {
  body: Record<string, unknown>;
}

function stub(payload?: Record<string, unknown>) {
  const calls: Recorded[] = [];

  const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify(
        payload ?? {
          id: 'chatcmpl-1',
          model: 'accounts/fireworks/models/kimi-k3',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'grounded [1]', reasoning_content: 'thinking' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const client = new FireworksClient({
    apiKey: 'fw_test',
    fetch: impl as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });

  return { client, calls };
}

const request = { system: 'you are an analyst', prompt: 'the sources', maxTokens: 500 };

describe('fireworksCompleter', () => {
  it('maps system and prompt onto chat roles', async () => {
    const { client, calls } = stub();

    await fireworksCompleter({ client })(request);

    expect(calls[0]!.body['messages']).toEqual([
      { role: 'system', content: 'you are an analyst' },
      { role: 'user', content: 'the sources' },
    ]);
  });

  it('returns text, model, stop reason, reasoning, and usage', async () => {
    const { client } = stub();

    const result = await fireworksCompleter({ client })(request);

    expect(result).toMatchObject({
      text: 'grounded [1]',
      model: 'accounts/fireworks/models/kimi-k3',
      stopReason: 'stop',
      reasoning: 'thinking',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('forwards the requested maxTokens', async () => {
    const { client, calls } = stub();

    await fireworksCompleter({ client })(request);

    expect(calls[0]!.body['max_tokens']).toBe(500);
  });

  it('falls back to the client default when the request asks for 0', async () => {
    const { client, calls } = stub();

    await fireworksCompleter({ client })({ ...request, maxTokens: 0 });

    expect(calls[0]!.body['max_tokens']).toBe(16_000);
  });

  it('passes the model and sampling options through', async () => {
    const { client, calls } = stub();

    await fireworksCompleter({
      client,
      model: 'accounts/fireworks/models/glm-5p2',
      temperature: 0.3,
      topK: 40,
    })(request);

    expect(calls[0]!.body).toMatchObject({
      model: 'accounts/fireworks/models/glm-5p2',
      temperature: 0.3,
      top_k: 40,
    });
  });

  it('throws on a truncated synthesis by default', async () => {
    const { client } = stub({
      id: 'x',
      model: 'accounts/fireworks/models/kimi-k3',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'half' }, finish_reason: 'length' },
      ],
      usage: {},
    });

    // A write-up cut off mid-sentence can leave dangling citations.
    await expect(fireworksCompleter({ client })(request)).rejects.toThrow(/truncated/);
  });

  it('returns the partial write-up when truncation is allowed', async () => {
    const { client } = stub({
      id: 'x',
      model: 'accounts/fireworks/models/kimi-k3',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'half' }, finish_reason: 'length' },
      ],
      usage: {},
    });

    const result = await fireworksCompleter({ client, failOnTruncation: false })(request);

    expect(result.text).toBe('half');
    expect(result.stopReason).toBe('length');
  });

  it('forwards an abort signal', async () => {
    const controller = new AbortController();
    const { client } = stub();

    await expect(
      fireworksCompleter({ client })({ ...request, signal: controller.signal }),
    ).resolves.toBeDefined();
  });
});
