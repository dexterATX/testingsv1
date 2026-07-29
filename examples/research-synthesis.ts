/**
 * The full pipeline: retrieve, chunk, rerank, dedupe, cluster, synthesize.
 *
 *   npm run example:synthesis "your research question"
 *   npm run example:synthesis -- --provider fireworks "your question"
 *
 * Needs EXA_API_KEY and VOXELL_API_KEY, plus a synthesis key: either
 * ANTHROPIC_API_KEY or FIREWORKS_API_KEY. Whichever is set is used; pass
 * --provider to choose explicitly when both are.
 *
 * Embeddings are cached to disk, so re-running the same question costs
 * nothing on the Voxell side.
 */

import {
  ExaClient,
  FileVectorStore,
  VoxellClient,
  anthropicCompleter,
  fireworksCompleter,
  researchSearch,
  synthesize,
  type Completer,
} from '../src/index.js';

const argv = process.argv.slice(2);
const providerFlag = argv.indexOf('--provider');
const requested = providerFlag === -1 ? undefined : argv[providerFlag + 1];
const words = argv.filter((_, i) => i !== providerFlag && i !== providerFlag + 1);

const query =
  words.join(' ') || 'how are engineering teams evaluating retrieval quality in RAG systems?';

function pickCompleter(): { name: string; completer: Completer } {
  const provider =
    requested ?? (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'fireworks');

  if (provider === 'anthropic') return { name: 'anthropic', completer: anthropicCompleter() };
  if (provider === 'fireworks') return { name: 'fireworks', completer: fireworksCompleter() };

  throw new Error(`Unknown --provider "${provider}". Use "anthropic" or "fireworks".`);
}

const exa = new ExaClient();
const voxell = new VoxellClient({
  store: new FileVectorStore({ path: '.cache/vectors.jsonl' }),
});

const report = await researchSearch(exa, voxell, {
  query,
  numResults: 25,
  chunk: true,
  cluster: true,
  topK: 12,
});

console.log(`\n${query}\n${'='.repeat(Math.min(query.length, 78))}\n`);

// --- Themes ----------------------------------------------------------------
for (const [index, cluster] of (report.clusters ?? []).entries()) {
  console.log(
    `Theme ${index + 1} (${cluster.members.length} result${
      cluster.members.length === 1 ? '' : 's'
    }, cohesion ${cluster.cohesion.toFixed(2)}): ${cluster.label}`,
  );
  for (const member of cluster.members) {
    const entry = report.results[member]!;
    console.log(`  [${entry.score.toFixed(3)}] ${entry.result.url}`);
  }
  console.log();
}

// --- Synthesis -------------------------------------------------------------
const { name: provider, completer } = pickCompleter();
console.log(`synthesizing with ${provider}...\n`);

const synthesis = await synthesize(report, { completer, maxSources: 10 });

console.log(`${'-'.repeat(78)}\n`);
console.log(synthesis.text);
console.log(`\n${'-'.repeat(78)}\nSources:`);

for (const source of synthesis.sources) {
  const mark = source.cited ? '·' : ' (uncited)';
  console.log(`  [${source.marker}]${mark} ${source.result.title ?? source.result.url}`);
  console.log(`       ${source.result.url}`);
}

// The check that makes the write-up trustworthy: a marker with no matching
// source means the model invented a citation.
if (synthesis.invalidMarkers.length > 0) {
  console.error(
    `\n!! Fabricated citations: ${synthesis.invalidMarkers.join(', ')} — ` +
      `these reference sources that do not exist. Do not trust this write-up as-is.`,
  );
  process.exitCode = 1;
}

const { stats } = report;
console.log(
  `\n${stats.retrieved} retrieved · ${stats.exactDuplicates} duplicate URLs · ` +
    `${stats.nearDuplicates} near-duplicates collapsed`,
);
console.log(
  `embedded ${stats.chunks} passages (${stats.cacheHits} cached) with ${stats.model} ` +
    `at ${stats.dim}d · ${stats.tokens} tokens`,
);
if (synthesis.usage) {
  console.log(
    `synthesis: ${synthesis.model} · ${synthesis.usage.inputTokens ?? 0} in / ` +
      `${synthesis.usage.outputTokens ?? 0} out`,
  );
}
