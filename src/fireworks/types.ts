/**
 * Request and response types for the Fireworks chat completions API.
 *
 * The wire format is OpenAI-compatible, with one notable addition:
 * reasoning models return their trace in `message.reasoning_content`,
 * separate from `message.content`.
 *
 * Verified against the live API on 2026-07-29.
 */

/** Models seen on `GET /v1/models`. Any model string is accepted. */
export const KNOWN_MODELS = [
  'accounts/fireworks/models/kimi-k3',
  'accounts/fireworks/routers/kimi-k3-fast',
  'accounts/fireworks/models/kimi-k2p6',
  'accounts/fireworks/models/kimi-k2p7-code',
  'accounts/fireworks/models/glm-5p1',
  'accounts/fireworks/models/glm-5p2',
  'accounts/fireworks/models/minimax-m2p7',
  'accounts/fireworks/models/minimax-m3',
  'accounts/fireworks/models/deepseek-v4-flash',
  'accounts/fireworks/models/deepseek-v4-pro',
  'accounts/fireworks/models/qwen3p7-plus',
  'accounts/fireworks/models/gpt-oss-120b',
  'accounts/fireworks/models/gpt-oss-20b',
  'accounts/fireworks/models/nemotron-3-ultra-nvfp4',
  'accounts/fireworks/models/inkling',
] as const;

export type KnownModel = (typeof KNOWN_MODELS)[number];

/** Any model id the account can reach. */
export type FireworksModel = KnownModel | (string & {});

export const DEFAULT_FIREWORKS_MODEL: FireworksModel = 'accounts/fireworks/models/kimi-k3';

export type ChatRole = 'system' | 'user' | 'assistant';

/** A text part, or an image reference for vision-capable models. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
}

export interface ChatCompletionRequest {
  model: FireworksModel;
  messages: ChatMessage[];
  /** Must be at least 1 — zero returns an empty completion, not an error. */
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string[];
  /** `{ type: 'json_object' }` constrains output to valid JSON. */
  response_format?: { type: 'json_object' | 'text' };
  stream?: boolean;
}

export interface ChatCompletionMessage {
  role: string;
  content: string | null;
  /**
   * Reasoning trace, on reasoning models such as kimi-k3. Not part of the
   * OpenAI schema. Its tokens are billed inside `usage.completion_tokens`.
   */
  reasoning_content?: string | null;
  tools?: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  /** `stop` on normal completion, `length` when `max_tokens` was hit. */
  finish_reason: string | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface ModelInfo {
  id: string;
  object: string;
  [key: string]: unknown;
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

/** One SSE chunk when `stream: true`. */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  usage?: ChatCompletionUsage;
}
