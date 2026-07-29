import { describe, expect, it } from 'vitest';

import { FireworksClient } from '../../src/fireworks/client.js';
import {
  FireworksAuthError,
  FireworksBadRequestError,
  FireworksError,
  FireworksModelNotFoundError,
  FireworksRequestValidationError,
  FireworksServerError,
} from '../../src/fireworks/errors.js';

const API_KEY = 'fw_test';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

/** Completion payload shaped exactly like the live API's. */
function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'accounts/fireworks/models/kimi-k3',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'the answer', reasoning_content: 'the thinking' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 93,
      completion_tokens: 50,
      total_tokens: 143,
      prompt_tokens_details: { cached_tokens: 7 },
    },
    ...overrides,
  };
}

function stub(queue: Array<Response | Error> = []) {
  const calls: Recorded[] = [];
  const pending = [...queue];

  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    calls.push({
      url: String(input),
      method: init?.method ?? 'POST',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(raw) as Record<string, unknown>,
    });

    const next = pending.shift();
    if (next instanceof Error) throw next;
    return next ?? jsonResponse(completion());
  };

  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

function makeClient(
  s: ReturnType<typeof stub>,
  options: Partial<ConstructorParameters<typeof FireworksClient>[0]> = {},
) {
  return new FireworksClient({
    apiKey: API_KEY,
    fetch: s.fetch,
    sleep: async () => {},
    ...options,
  });
}

const hello = [{ role: 'user' as const, content: 'hello' }];

describe('construction', () => {
  it('reads the key from FIREWORKS_API_KEY', () => {
    const previous = process.env['FIREWORKS_API_KEY'];
    process.env['FIREWORKS_API_KEY'] = 'from-env';
    try {
      expect(() => new FireworksClient()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env['FIREWORKS_API_KEY'];
      else process.env['FIREWORKS_API_KEY'] = previous;
    }
  });

  it('throws an actionable error when no key is configured', () => {
    const previous = process.env['FIREWORKS_API_KEY'];
    delete process.env['FIREWORKS_API_KEY'];
    try {
      expect(() => new FireworksClient()).toThrow(/Missing Fireworks API key/);
    } finally {
      if (previous !== undefined) process.env['FIREWORKS_API_KEY'] = previous;
    }
  });
});

describe('chat', () => {
  it('posts to the OpenAI-compatible path with a Bearer token', async () => {
    const s = stub();
    await makeClient(s).chat(hello);

    expect(s.calls[0]!.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(s.calls[0]!.headers['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('defaults to kimi-k3 and honors an override', async () => {
    const s = stub();
    const client = makeClient(s);

    await client.chat(hello);
    expect(s.calls[0]!.body['model']).toBe('accounts/fireworks/models/kimi-k3');

    await client.chat(hello, { model: 'accounts/fireworks/models/glm-5p2' });
    expect(s.calls[1]!.body['model']).toBe('accounts/fireworks/models/glm-5p2');
  });

  it('returns text, reasoning, model, and mapped usage', async () => {
    const s = stub();
    const result = await makeClient(s).chat(hello);

    expect(result.text).toBe('the answer');
    expect(result.reasoning).toBe('the thinking');
    expect(result.model).toBe('accounts/fireworks/models/kimi-k3');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      promptTokens: 93,
      completionTokens: 50,
      totalTokens: 143,
      cachedPromptTokens: 7,
    });
  });

  it('passes sampling options through in snake_case', async () => {
    const s = stub();
    await makeClient(s).chat(hello, {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stop: ['END'],
      responseFormat: 'json_object',
    });

    expect(s.calls[0]!.body).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      stop: ['END'],
      response_format: { type: 'json_object' },
    });
  });

  it('omits sampling options that were not set', async () => {
    const s = stub();
    await makeClient(s).chat(hello);

    expect(s.calls[0]!.body).not.toHaveProperty('temperature');
    expect(s.calls[0]!.body).not.toHaveProperty('top_k');
  });

  it('handles a response with no reasoning_content', async () => {
    const s = stub([
      jsonResponse(
        completion({
          choices: [
            { index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' },
          ],
        }),
      ),
    ]);

    const result = await makeClient(s).chat(hello);

    expect(result.text).toBe('plain');
    expect(result.reasoning).toBeUndefined();
  });
});

describe('input validation', () => {
  it('rejects maxTokens below 1, which the API answers with an empty completion', async () => {
    const s = stub();

    await expect(makeClient(s).chat(hello, { maxTokens: 0 })).rejects.toThrow(
      FireworksRequestValidationError,
    );
    await expect(makeClient(s).chat(hello, { maxTokens: 0 })).rejects.toThrow(
      /accepts 0 and returns an empty completion/,
    );
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a non-integer maxTokens', async () => {
    const s = stub();
    await expect(makeClient(s).chat(hello, { maxTokens: 1.5 })).rejects.toThrow(/integer/);
  });

  it('rejects an empty messages array', async () => {
    const s = stub();
    await expect(makeClient(s).chat([])).rejects.toThrow(/non-empty array/);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a blank message', async () => {
    const s = stub();
    await expect(
      makeClient(s).chat([{ role: 'user', content: '   ' }]),
    ).rejects.toThrow(/messages\[0\].content is empty/);
  });

  it('allows structured content parts through untouched', async () => {
    const s = stub();
    await makeClient(s).chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
        ],
      },
    ]);

    expect(s.calls[0]!.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
        ],
      },
    ]);
  });
});

describe('truncation', () => {
  const truncated = () =>
    jsonResponse(
      completion({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'half a sen' },
            finish_reason: 'length',
          },
        ],
      }),
    );

  it('throws by default, rather than returning a half-written answer', async () => {
    const s = stub([truncated()]);

    await expect(makeClient(s).chat(hello, { maxTokens: 12 })).rejects.toThrow(
      /stopped at the 12-token limit/,
    );
  });

  it('mentions that reasoning tokens share the budget', async () => {
    const s = stub([truncated()]);

    await expect(makeClient(s).chat(hello)).rejects.toThrow(/trace consumes this budget/);
  });

  it('returns the partial answer when told to', async () => {
    const s = stub([truncated()]);

    const result = await makeClient(s).chat(hello, { failOnTruncation: false });

    expect(result.text).toBe('half a sen');
    expect(result.finishReason).toBe('length');
  });
});

describe('error mapping', () => {
  it('maps 404 to a model-not-found error naming the models endpoint', async () => {
    const s = stub([
      jsonResponse(
        { error: { message: 'Model not found, inaccessible, and/or not deployed' } },
        { status: 404 },
      ),
    ]);

    const error = await makeClient(s).chat(hello).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FireworksModelNotFoundError);
    expect((error as Error).message).toMatch(/Model not found/);
    expect((error as Error).message).toMatch(/GET \/v1\/models/);
    expect(s.calls).toHaveLength(1);
  });

  it('maps 401 to an auth error', async () => {
    const s = stub([
      jsonResponse({ error: { message: 'The API key you provided is invalid.' } }, { status: 401 }),
    ]);

    await expect(makeClient(s).chat(hello)).rejects.toThrow(FireworksAuthError);
  });

  it('maps 400 to a bad-request error and surfaces the API message', async () => {
    const s = stub([
      jsonResponse({ error: { message: 'messages is required' } }, { status: 400 }),
    ]);

    const error = await makeClient(s).chat(hello).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FireworksBadRequestError);
    expect((error as Error).message).toMatch(/messages is required/);
  });

  it('captures the snake_case request_id Fireworks returns', async () => {
    const s = stub([
      jsonResponse({ error: { message: 'nope' }, request_id: 'chatcmpl-abc' }, { status: 400 }),
    ]);

    await expect(makeClient(s).chat(hello)).rejects.toMatchObject({ requestId: 'chatcmpl-abc' });
  });

  it('retries a 429 then succeeds', async () => {
    const s = stub([jsonResponse({ error: { message: 'slow down' } }, { status: 429 })]);

    const result = await makeClient(s).chat(hello);

    expect(s.calls).toHaveLength(2);
    expect(result.text).toBe('the answer');
  });

  it('retries 5xx and gives up as a server error', async () => {
    const s = stub([
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    ]);

    await expect(makeClient(s, { maxRetries: 1 }).chat(hello)).rejects.toThrow(
      FireworksServerError,
    );
    expect(s.calls).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    const s = stub([jsonResponse({ error: { message: 'bad' } }, { status: 400 })]);

    await expect(makeClient(s).chat(hello)).rejects.toThrow(FireworksBadRequestError);
    expect(s.calls).toHaveLength(1);
  });

  it('raises a protocol error when the response has no choices', async () => {
    const s = stub([jsonResponse({ id: 'x', object: 'chat.completion', choices: [] })]);

    await expect(makeClient(s).chat(hello)).rejects.toThrow(/no choices/);
  });

  it('every error extends FireworksError', async () => {
    const s = stub([jsonResponse({ error: { message: 'bad' } }, { status: 400 })]);

    await expect(makeClient(s).chat(hello)).rejects.toBeInstanceOf(FireworksError);
  });
});

describe('models', () => {
  it('issues a GET to /models', async () => {
    const s = stub([
      jsonResponse({ object: 'list', data: [{ id: 'accounts/fireworks/models/kimi-k3' }] }),
    ]);

    const response = await makeClient(s).models();

    expect(s.calls[0]!.method).toBe('GET');
    expect(s.calls[0]!.url).toBe('https://api.fireworks.ai/inference/v1/models');
    expect(response.data[0]!.id).toBe('accounts/fireworks/models/kimi-k3');
  });
});
