/**
 * `/contents` for URLs you already have, and `/answer` for question-first UIs.
 *
 * Note the shape difference: on `/contents`, `text`/`highlights`/`summary` are
 * top-level. On `/search` the same fields nest under `contents`.
 *
 *   npm run example:contents
 */

import { ExaClient } from '../src/index.js';

const exa = new ExaClient();

// --- /contents -------------------------------------------------------------
// maxAgeHours: 24 means "use the cache if it was crawled within a day,
// otherwise livecrawl".
const contents = await exa.contents(
  ['https://arxiv.org/abs/2307.06435', 'https://exa.ai/docs'],
  { highlights: true, maxAgeHours: 24 },
);

for (const result of contents.results) {
  console.log(`${result.title ?? '(untitled)'} — ${result.url}`);
  for (const highlight of result.highlights ?? []) {
    console.log(`  > ${highlight.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

// A URL that could not be fetched is reported here rather than throwing, so
// check statuses before assuming every input produced a result.
for (const status of contents.statuses ?? []) {
  if (status.status === 'error') {
    console.warn(`  ! ${status.id}: ${status.error?.tag ?? 'unknown error'}`);
  }
}

// --- /answer ---------------------------------------------------------------
const answer = await exa.answer('What is the latest valuation of SpaceX?', { text: false });

console.log(`\n${answer.answer}`);
for (const citation of answer.citations) {
  console.log(`  [${citation.title ?? citation.url}](${citation.url})`);
}
