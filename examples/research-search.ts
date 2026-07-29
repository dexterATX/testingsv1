/**
 * The Exa → Voxell research pipeline.
 *
 * Exa retrieves broadly, then Voxell embeddings re-score every result against
 * the question and collapse restatements of the same story.
 *
 *   npm run example:research
 *
 * Needs both EXA_API_KEY and VOXELL_API_KEY.
 */

import { ExaClient, VoxellClient, researchSearch } from '../src/index.js';

const query = process.argv.slice(2).join(' ') ||
  'how are engineering teams evaluating retrieval quality in RAG systems?';

const exa = new ExaClient();
const voxell = new VoxellClient();

const report = await researchSearch(exa, voxell, {
  query,
  numResults: 25,
  topK: 10,
  // Uncomment to force a broader sweep before ranking:
  // search: { type: 'deep', additionalQueries: ['RAG evaluation metrics', 'retrieval recall@k'] },
});

console.log(`\n${report.query}\n${'='.repeat(Math.min(report.query.length, 78))}\n`);

for (const [index, entry] of report.results.entries()) {
  const move =
    entry.rankDelta > 0 ? `↑${entry.rankDelta}` : entry.rankDelta < 0 ? `↓${-entry.rankDelta}` : '–';

  console.log(
    `${String(index + 1).padStart(2)}. [${entry.score.toFixed(3)}] ${move.padStart(3)}  ` +
      `${entry.result.title ?? '(untitled)'}`,
  );
  console.log(`    ${entry.result.url}`);

  const highlight = entry.result.highlights?.[0];
  if (highlight) console.log(`    > ${highlight.replace(/\s+/g, ' ').slice(0, 150)}`);

  for (const duplicate of entry.duplicates) {
    console.log(
      `    ⤷ also covered (${duplicate.similarity.toFixed(3)}): ${duplicate.result.url}`,
    );
  }
  console.log();
}

const { stats } = report;
console.log(
  `${stats.retrieved} retrieved · ${stats.exactDuplicates} duplicate URLs · ` +
    `${stats.nearDuplicates} near-duplicates collapsed · ${stats.belowThreshold} below threshold`,
);
console.log(
  `embedded ${stats.embedded} texts (${stats.cacheHits} cached) with ${stats.model} ` +
    `at ${stats.dim}d · ${stats.tokens} tokens · ${stats.embedLatencyMs}ms`,
);
if (report.exa.costDollars) console.log(`exa cost: $${report.exa.costDollars.total}`);
