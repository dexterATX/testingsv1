import { describe, expect, it } from 'vitest';

import { namesAProvider, redactErrorName, redactMessage } from '../../src/server/redact.js';

/**
 * These are the real messages the clients throw, copied verbatim. The point of
 * the test is not that the wording is pretty — it is that nothing the browser
 * receives says which APIs are behind the tool.
 */
const REAL_MESSAGES = [
  'Missing Exa API key. Set EXA_API_KEY in the environment (see .env.example) or pass { apiKey }.',
  'Missing Voxell API key. Set VOXELL_API_KEY in the environment (see .env.example) or pass { apiKey }.',
  'Missing Fireworks API key. Set FIREWORKS_API_KEY in the environment or pass { apiKey }.',
  'Missing or invalid Anthropic API key. Set ANTHROPIC_API_KEY (see .env.example).',
  'Exa request failed: POST https://api.exa.ai/search returned 429.',
  'Voxell request timed out after 30000ms (https://api.voxell.ai/v1/embeddings).',
  'Model accounts/fireworks/models/kimi-k3 is not available to this account.',
  'claude-opus-5 declined the request (stop_reason: refusal).',
  'Backing model qwen3-native-28l returned a 502 for an empty input.',
];

describe('redactMessage', () => {
  it('leaves no provider or model name in any real error message', () => {
    for (const message of REAL_MESSAGES) {
      const redacted = redactMessage(message);

      expect(namesAProvider(message), `fixture should name a provider: ${message}`).toBe(true);
      expect(namesAProvider(redacted), `still names a provider: ${redacted}`).toBe(false);
    }
  });

  it('keeps the message actionable', () => {
    expect(redactMessage(REAL_MESSAGES[0]!)).toBe(
      'Missing search API key. Set the search API key in the environment (see .env.example) or pass { apiKey }.',
    );
  });

  it('preserves the part of the message that says what went wrong', () => {
    expect(redactMessage(REAL_MESSAGES[4]!)).toMatch(/429/);
    expect(redactMessage(REAL_MESSAGES[5]!)).toMatch(/timed out after 30000ms/);
  });

  it('replaces a URL whole, rather than mangling the vendor out of its host', () => {
    const out = redactMessage('GET https://api.exa.ai/search?q=1 failed');

    expect(out).toBe('GET the upstream endpoint failed');
  });

  it('redacts anything shaped like a credential, wherever it appears', () => {
    const out = redactMessage('Rejected key fw_WTeNjjiNkDjN51WHEbAAkw for this account.');

    expect(out).toBe('Rejected key [redacted] for this account.');
  });

  it('is a no-op on a message that names nothing', () => {
    const message = 'Request body too large.';

    expect(redactMessage(message)).toBe(message);
  });
});

describe('redactErrorName', () => {
  it('swaps the vendor prefix for the stage, keeping the failure kind', () => {
    expect(redactErrorName('ExaAuthError')).toBe('SearchAuthError');
    expect(redactErrorName('ExaRateLimitError')).toBe('SearchRateLimitError');
    expect(redactErrorName('VoxellTimeoutError')).toBe('EmbeddingTimeoutError');
    expect(redactErrorName('FireworksServerError')).toBe('WriteupServerError');
    expect(redactErrorName('AnthropicError')).toBe('WriteupError');
  });

  it('leaves a name that already says nothing about the vendor', () => {
    expect(redactErrorName('SynthesisRefusedError')).toBe('SynthesisRefusedError');
    expect(redactErrorName('Error')).toBe('Error');
  });
});

describe('namesAProvider', () => {
  it('does not fire on ordinary words that merely start the same way', () => {
    // `exact` and `example.com` show up constantly in stats lines and results.
    expect(namesAProvider('12 exact duplicates from example.com')).toBe(false);
    expect(namesAProvider('hexadecimal')).toBe(false);
  });
});
