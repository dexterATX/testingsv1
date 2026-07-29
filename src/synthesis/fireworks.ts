/**
 * A `Completer` backed by Fireworks.
 *
 * Drop-in alternative to `anthropicCompleter` — same interface, so the
 * synthesis prompt and the citation checking are unchanged.
 */

import { FireworksClient, type FireworksClientOptions } from '../fireworks/client.js';
import type { FireworksModel } from '../fireworks/types.js';
import type { Completer } from './types.js';

export interface FireworksCompleterOptions extends FireworksClientOptions {
  /** Overrides the client default. */
  model?: FireworksModel;
  temperature?: number;
  topP?: number;
  topK?: number;
  /**
   * Throw rather than return a truncated write-up. Defaults to true — a
   * synthesis cut off mid-sentence can leave dangling citations, which is
   * worse than a clear failure.
   */
  failOnTruncation?: boolean;
  /** Reuse an existing client instead of constructing one. */
  client?: FireworksClient;
}

/**
 * Builds a `Completer` that calls Fireworks.
 *
 * @example
 * const synthesis = await synthesize(report, {
 *   completer: fireworksCompleter({ model: 'accounts/fireworks/models/kimi-k3' }),
 * });
 */
export function fireworksCompleter(options: FireworksCompleterOptions = {}): Completer {
  const { model, temperature, topP, topK, failOnTruncation, client, ...clientOptions } = options;
  const fireworks = client ?? new FireworksClient(clientOptions);

  return async (request) => {
    const result = await fireworks.chat(
      [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      {
        ...(model !== undefined ? { model } : {}),
        ...(request.maxTokens > 0 ? { maxTokens: request.maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
        ...(topK !== undefined ? { topK } : {}),
        ...(failOnTruncation !== undefined ? { failOnTruncation } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    return {
      text: result.text,
      model: result.model,
      ...(result.finishReason ? { stopReason: result.finishReason } : {}),
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      usage: {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
      },
    };
  };
}
