/** Fixtures for the Voxell client tests. */

export interface RecordedEmbedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { texts?: string[]; model?: string };
}

/** A deterministic unit vector derived from the text, mimicking the real API. */
export function fakeVector(text: string, dim = 8): number[] {
  const raw = Array.from({ length: dim }, (_, i) => {
    let hash = 2166136261 ^ (i * 16777619);
    for (let c = 0; c < text.length; c += 1) {
      hash ^= text.charCodeAt(c);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 2000) / 1000 - 1;
  });

  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

export interface EmbedStub {
  fetch: typeof globalThis.fetch;
  calls: RecordedEmbedCall[];
}

/**
 * A fetch stub that answers `/v1/embed` with one deterministic vector per
 * input text, so batching and ordering can be asserted precisely.
 *
 * `overrides` can queue explicit responses (or errors) that take precedence,
 * one per call, for exercising failure paths.
 */
export function embedStub(
  options: { dim?: number; overrides?: Array<Response | Error> } = {},
): EmbedStub {
  const dim = options.dim ?? 8;
  const overrides = [...(options.overrides ?? [])];
  const calls: RecordedEmbedCall[] = [];

  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as { texts?: string[]; model?: string };

    calls.push({
      url: String(input),
      method: init?.method ?? 'POST',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });

    const override = overrides.shift();
    if (override instanceof Error) throw override;
    if (override) return override;

    if (String(input).endsWith('/v1/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'forge-turbo', object: 'model', created: 1, owned_by: 'voxell' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const texts = body.texts ?? [];
    return new Response(
      JSON.stringify({
        dim,
        embeddings: texts.map((text) => fakeVector(text, dim)),
        latency_ms: 5,
        model: 'qwen3-native-28l',
        tokens: texts.length * 3,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

export const noSleep = async (): Promise<void> => {};
