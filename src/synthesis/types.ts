/**
 * Synthesis is provider-agnostic: it takes a `Completer` rather than an SDK
 * client, so the prompt construction and citation checking are testable
 * without a network or an API key, and a different model can be swapped in.
 */

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export interface CompletionResult {
  text: string;
  /** The model that actually produced the text (may differ under fallback). */
  model?: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type Completer = (request: CompletionRequest) => Promise<CompletionResult>;

/** Base class for synthesis failures. */
export class SynthesisError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The model's safety classifiers declined the request.
 *
 * This is a successful HTTP 200 with `stop_reason: "refusal"`, not an API
 * error — surfaced as an exception here so callers cannot mistake an empty
 * response for a real answer.
 */
export class SynthesisRefusedError extends SynthesisError {
  /** Refusal category, e.g. `cyber` or `bio`. May be absent. */
  readonly category: string | undefined;

  constructor(message: string, init: { category?: string | undefined } = {}) {
    super(message);
    this.category = init.category;
  }
}
