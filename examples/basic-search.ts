/**
 * Pattern 1 — raw retrieval for your own agent.
 *
 * Use this when your code inspects `results` directly, passes `highlights`
 * into your own LLM, or exposes Exa as a tool inside an existing agent loop.
 *
 *   npm run example:search
 */

import { ExaClient } from '../src/index.js';

const exa = new ExaClient();

const response = await exa.search('best open source vector databases for RAG', {
  type: 'auto',
  numResults: 10,
  contents: { highlights: true },
});

console.log(`requestId: ${response.requestId} (searchType: ${response.searchType})`);
console.log(`${response.results.length} results\n`);

for (const [index, result] of response.results.entries()) {
  console.log(`${index + 1}. ${result.title ?? '(untitled)'}`);
  console.log(`   ${result.url}`);

  for (const highlight of result.highlights ?? []) {
    console.log(`   > ${highlight.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log();
}

if (response.costDollars) {
  console.log(`cost: $${response.costDollars.total}`);
}
