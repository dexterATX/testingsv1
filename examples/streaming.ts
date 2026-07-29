/**
 * Streaming search — `stream: true` switches `/search` to SSE mode and emits
 * OpenAI-compatible chat-completion chunks.
 *
 *   npm run example:stream
 */

import { ExaClient, streamText } from '../src/index.js';

const exa = new ExaClient();

const chunks = exa.searchStream('summarize recent progress in small language models', {
  type: 'deep-lite',
  systemPrompt: 'Prefer primary sources and be concise.',
  contents: { highlights: true },
});

// streamText pulls just the incremental text out of each chunk. Iterate
// `chunks` directly instead if you also need the results/grounding that Exa
// attaches as they resolve.
for await (const text of streamText(chunks)) {
  process.stdout.write(text);
}

process.stdout.write('\n');
