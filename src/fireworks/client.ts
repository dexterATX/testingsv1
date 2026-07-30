/**
 * A typed client for the Fireworks chat completions API.
 *
 * The wire format is OpenAI-compatible. Three things about it shaped this
 * client, all verified against the live API:
 *
 * - **`max_tokens: 0` returns HTTP 200 with empty content** and
 *   `finish_reason: "length"` — a silent empty answer rather than an error.
 *   Rejected client-side.
 * - **`finish_reason: "length"` means the output was cut off.** For anything
 *   that has to be complete (a write-up, a JSON payload), a truncated result
 *   is a failure, so `chat()` can be told to treat it as one.
 * - **Reasoning models return `reasoning_content` separately**, and its tokens
 *   are billed inside `usage.completion_tokens` — so a short answer can cost
 *   far more than its length suggests.
 */

import { HttpTransport, type RequestOverrides } from '../http/transport.js';
import {
  FireworksError,
  FireworksRequestValidationError,
  fireworksErrorAdapter,
} from './errors.js';
import {
  DEFAULT_FIREWORKS_MODEL,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type FireworksModel,
  type ModelsResponse,
} from './types.js';

export type { RequestOverrides };

const DEFAULT_BASE_URL = 'https://api.fireworks.ai/inference/v1';
/** Reasoning models can think for a long while before emitting text. */
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TOKENS = 16_000;

export interface FireworksClientOptions {
  /** Defaults to `process.env.FIREWORKS_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.FIREWORKS_BASE_URL` or the public endpoint. */
  baseUrl?: string;
  /** Default model. Defaults to `accounts/fireworks/models/kimi-k3`. */
  model?: FireworksModel;
  /** Default output cap. Defaults to 16000. */
  maxTokens?: number;
  /** Per-request timeout in ms. Defaults to 300000. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors. Defaults to 4. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Defaults to 1000. */
  retryBaseMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests, so backoff does not make suites slow. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ChatOptions extends RequestOverrides {
  model?: FireworksModel;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  /** `'json_object'` constrains the reply to valid JSON. */
  responseFormat?: 'json_object' | 'text';
  /**
   * Throw when the model hit `max_tokens` instead of returning a truncated
   * answer. Defaults to true — a half-written result is usually worse than an
   * error, because nothing downstream can tell it was cut off.
   */
  failOnTruncation?: boolean;
}

export interface ChatResult {
  /** The assistant's text. */
  text: string;
  /** Reasoning trace, when the model emits one. */
  reasoning: string | undefined;
  /** The model that served the request. */
  model: string;
  /** `stop` on normal completion, `length` if truncated. */
  finishReason: string | undefined;
  usage: {
    promptTokens: number | undefined;
    /** Includes reasoning tokens on reasoning models. */
    completionTokens: number | undefined;
    totalTokens: number | undefined;
    cachedPromptTokens: number | undefined;
  };
  /** The raw response, for anything not surfaced above. */
  raw: ChatCompletionResponse;
}

export class FireworksClient {
  private readonly transport: HttpTransport;
  private readonly defaultModel: FireworksModel;
  private readonly defaultMaxTokens: number;

  constructor(options: FireworksClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env['FIREWORKS_API_KEY'];

    if (!apiKey) {
      throw new FireworksRequestValidationError(
        'Missing Fireworks API key. Set FIREWORKS_API_KEY in the environment ' +
          '(see .env.example) or pass `new FireworksClient({ apiKey })`.',
      );
    }

    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') {
      throw new FireworksError(
        'No global fetch available. Use Node 18+ or pass `fetch` explicitly.',
      );
    }

    this.defaultModel = options.model ?? DEFAULT_FIREWORKS_MODEL;
    this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.transport = new HttpTransport({
      baseUrl: options.baseUrl ?? process.env['FIREWORKS_BASE_URL'] ?? DEFAULT_BASE_URL,
      authHeaders: { Authorization: `Bearer ${apiKey}` },
      errors: fireworksErrorAdapter,
      defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });
  }

  /**
   * `POST /chat/completions`.
   *
   * @example
   * const { text } = await fw.chat([{ role: 'user', content: 'Summarize X' }]);
   */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const maxTokens = options.maxTokens ?? this.defaultMaxTokens;

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new FireworksRequestValidationError('`messages` must be a non-empty array.');
    }

    // The API accepts max_tokens: 0 and returns an empty completion with
    // finish_reason "length" — a silent no-op you still pay prompt tokens for.
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new FireworksRequestValidationError(
        `\`maxTokens\` must be an integer of at least 1, got ${maxTokens}. ` +
          `The API accepts 0 and returns an empty completion rather than an error.`,
      );
    }

    for (const [index, message] of messages.entries()) {
      if (typeof message?.content === 'string' && message.content.trim() === '') {
        throw new FireworksRequestValidationError(
          `messages[${index}].content is empty. Drop the message instead.`,
        );
      }
    }

    const body: ChatCompletionRequest = {
      model: options.model ?? this.defaultModel,
      messages,
      max_tokens: maxTokens,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.topK !== undefined ? { top_k: options.topK } : {}),
      ...(options.presencePenalty !== undefined
        ? { presence_penalty: options.presencePenalty }
        : {}),
      ...(options.frequencyPenalty !== undefined
        ? { frequency_penalty: options.frequencyPenalty }
        : {}),
      ...(options.stop !== undefined ? { stop: options.stop } : {}),
      ...(options.responseFormat !== undefined
        ? { response_format: { type: options.responseFormat } }
        : {}),
    };

    const response = await this.transport.request<ChatCompletionResponse>({
      path: '/chat/completions',
      body,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    const choice = response?.choices?.[0];
    if (!choice) {
      throw new FireworksError('Fireworks response contained no choices.');
    }

    const finishReason = choice.finish_reason ?? undefined;
    const text = choice.message?.content ?? '';

    if ((options.failOnTruncation ?? true) && finishReason === 'length') {
      throw new FireworksError(
        `Fireworks stopped at the ${maxTokens}-token limit, so the reply is truncated ` +
          `(${text.length} characters returned). Raise \`maxTokens\`, or pass ` +
          `{ failOnTruncation: false } to accept partial output. Note that on reasoning ` +
          `models the trace consumes this budget too.`,
      );
    }

    return {
      text,
      reasoning: choice.message?.reasoning_content ?? undefined,
      model: response.model,
      finishReason,
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
        cachedPromptTokens: response.usage?.prompt_tokens_details?.cached_tokens,
      },
      raw: response,
    };
  }

  /** `GET /v1/models` — the model ids this key can reach. */
  async models(options: RequestOverrides = {}): Promise<ModelsResponse> {
    return this.transport.request<ModelsResponse>({
      path: '/models',
      method: 'GET',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
}
