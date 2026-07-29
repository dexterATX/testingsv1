/**
 * Grounded synthesis over a research report.
 *
 * @example
 * import { anthropicCompleter, synthesize } from './synthesis/index.js';
 *
 * const synthesis = await synthesize(report, { completer: anthropicCompleter() });
 * console.log(synthesis.text);
 */

export { anthropicCompleter, DEFAULT_SYNTHESIS_MODEL } from './anthropic.js';
export type { AnthropicCompleterOptions, Effort } from './anthropic.js';

export { extractCitationMarkers, synthesize } from './synthesize.js';
export type { Synthesis, SynthesisSource, SynthesizeOptions } from './synthesize.js';

export { SynthesisError, SynthesisRefusedError } from './types.js';
export type { Completer, CompletionRequest, CompletionResult } from './types.js';
