/**
 * A `Completer` backed by the Claude API, via the official Anthropic SDK.
 *
 * Two behaviors here are specific to the current Opus generation and easy to
 * get wrong:
 *
 * - **A refusal is an HTTP 200**, not an error. `stop_reason: "refusal"` comes
 *   back with empty or partial content, so the stop reason is checked before
 *   the content is read — otherwise a declined request looks like an empty
 *   answer.
 * - **Server-side fallbacks are opt-in.** Without them a declined request just
 *   stops; with `fallbacks: "default"` the API re-runs it on a fallback model
 *   chosen by refusal category, in the same call.
 */

import Anthropic from '@anthropic-ai/sdk';

import { SynthesisError, SynthesisRefusedError, type Completer } from './types.js';

/** Effort controls reasoning depth and total token spend. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_SYNTHESIS_MODEL = 'claude-opus-5';

/** Beta flag gating the `fallbacks: "default"` scalar form. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicCompleterOptions {
  /** Defaults to the SDK's own resolution (`ANTHROPIC_API_KEY`, or a profile). */
  apiKey?: string;
  /** Defaults to `claude-opus-5`. */
  model?: string;
  /** Defaults to `high`. */
  effort?: Effort;
  /** Default output cap. Kept under the SDK's non-streaming HTTP timeout. */
  maxTokens?: number;
  /**
   * Re-run a policy-declined request on a fallback model server-side.
   * Defaults to true.
   */
  fallbacks?: boolean;
  /** Injectable for tests. */
  client?: Anthropic;
}

const DEFAULT_MAX_TOKENS = 16_000;

/** Builds a `Completer` that calls the Claude API. */
export function anthropicCompleter(options: AnthropicCompleterOptions = {}): Completer {
  const model = options.model ?? DEFAULT_SYNTHESIS_MODEL;
  const effort: Effort = options.effort ?? 'high';
  const defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const useFallbacks = options.fallbacks ?? true;

  const client =
    options.client ??
    new Anthropic(options.apiKey !== undefined ? { apiKey: options.apiKey } : {});

  return async (request) => {
    const params = {
      model,
      max_tokens: request.maxTokens || defaultMaxTokens,
      system: request.system,
      messages: [{ role: 'user' as const, content: request.prompt }],
      output_config: { effort },
      ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      // Cast: `fallbacks: "default"` is newer than the SDK's typings.
      response = await client.beta.messages.create(
        params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming,
        request.signal ? { signal: request.signal } : {},
      );
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new SynthesisError(`Claude API rate limited: ${error.message}`, { cause: error });
      }
      if (error instanceof Anthropic.AuthenticationError) {
        throw new SynthesisError(
          'Missing or invalid Anthropic API key. Set ANTHROPIC_API_KEY (see .env.example).',
          { cause: error },
        );
      }
      if (error instanceof Anthropic.APIError) {
        throw new SynthesisError(`Claude API error ${error.status}: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }

    // Check the stop reason before touching content: a refusal returns 200
    // with empty or partial content.
    if (response.stop_reason === 'refusal') {
      const details = response.stop_details as { category?: string } | null | undefined;
      throw new SynthesisRefusedError(
        `Claude declined to synthesize this research${
          details?.category ? ` (category: ${details.category})` : ''
        }.`,
        { category: details?.category },
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      model: response.model,
      ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
    };
  };
}
