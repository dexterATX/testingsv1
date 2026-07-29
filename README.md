# research-toolkit

A research tool built from two APIs: **Exa** for broad retrieval, **Voxell**
embeddings for semantic precision on top of it.

Exa finds candidates. Voxell then re-scores every candidate against the actual
question and collapses restatements of the same story — the two models disagree
often enough that the second pass is what turns a search result list into
something you can read.

Dependency-free TypeScript on Node 20+ native `fetch`.

```
Exa /search  ──▶  highlights  ──▶  Voxell /v1/embed  ──▶  rerank  ──▶  dedupe
```

- **Typed clients for both APIs**, mirroring each wire format exactly
- **Validates before it sends** — documented (Exa) and measured (Voxell)
  constraints are checked client-side, so mistakes fail immediately instead of
  costing a round trip
- **One shared transport** — timeouts, retry with jitter, `Retry-After`, typed
  errors, for both providers
- **Batching, dedupe, and caching** on embeddings, so a 25-result rerank is one
  HTTP request and a repeat run is free

## Setup

```bash
cp .env.example .env     # then fill in EXA_API_KEY and VOXELL_API_KEY
npm install
npm run check            # typecheck + 213 tests, no network, no keys needed
```

Then a live run:

```bash
npm run example:research "how are teams evaluating RAG retrieval quality?"
```

Keys come from `EXA_API_KEY` ([dashboard](https://dashboard.exa.ai)) and
`VOXELL_API_KEY`. The npm scripts load `.env` via Node's native
`--env-file-if-exists`, so there is no dotenv dependency.

> **Voxell auth:** the header is `Authorization: Bearer <key>`. A bare key
> 401s. See [the reference](docs/voxell-api-reference.md#authentication) — this
> is the most common mistake with that API.

## The research pipeline

```ts
import { ExaClient, VoxellClient, researchSearch } from './src/index.js';

const report = await researchSearch(new ExaClient(), new VoxellClient(), {
  query: 'how are engineering teams evaluating retrieval quality in RAG systems?',
  numResults: 25,
  topK: 10,
});

for (const entry of report.results) {
  console.log(entry.score.toFixed(3), entry.result.title, entry.result.url);
  for (const dup of entry.duplicates) {
    console.log('  also covered:', dup.result.url);
  }
}
```

What it does, in order:

1. **Search** — Exa with `contents: { highlights: true }`
2. **Drop exact duplicates** — by canonical URL, before spending an embedding
3. **Embed** — the query and every result in a single batched request
4. **Rerank** — by cosine similarity to the query; Exa's order breaks ties
5. **Dedupe** — collapse results within `dedupeThreshold` of a higher-ranked one
6. **Filter** — `minScore`, then `topK`

| Option | Default | Notes |
|---|---|---|
| `numResults` | 25 | Passed to Exa |
| `search` | `{}` | Any `SearchOptions`, merged over the defaults |
| `model` | client default | `turbo` / `pro` / `ultra-4k` |
| `dedupe` | `true` | |
| `dedupeThreshold` | `0.92` | Cosine at or above which two results are one story |
| `minScore` | — | Drop results below this similarity to the query |
| `topK` | — | Keep the best N after ranking and dedupe |

Each result carries `score`, `originalRank`, `rankDelta` (positive means the
rerank promoted it), the absorbed `duplicates`, and the `embeddedText` that
produced the score. `report.exa` keeps the raw response, so nothing the
pipeline discarded is lost.

### Tuning the dedupe threshold

`0.92` is calibrated, not guessed: against Voxell `turbo`, two rewrites of one
news story score above it while distinct-but-related articles score below.
`test/live/pipeline.live.test.ts` asserts exactly that, and is the test that
should fail first if Voxell changes models. Raise the threshold if real results
are being absorbed; lower it if near-identical pages are surviving.

## Exa client

Wraps `/search`, `/contents`, and `/answer`. Field names mirror the raw JSON
API, so anything in the Exa docs passes through unchanged.

```ts
const res = await exa.search('best open source vector databases', {
  type: 'auto',
  numResults: 10,
  contents: { highlights: true },
});
```

Search types, cheapest first: `instant` (~250 ms) · `fast` (~450 ms) · `auto`
(~1 s, default) · `deep-lite` (~4 s) · `deep` (4–15 s) · `deep-reasoning`
(12–40 s). The client sets a per-type timeout with headroom for the synthesis
and livecrawl latency that stacks on top.

For grounded structured output, pass an `outputSchema` — it works on every
search type, and `search<T>()` types `output.content`:

```ts
const res = await exa.search<{ summary: string }>('...', {
  type: 'deep',
  systemPrompt: 'Prefer official sources, collapse duplicate reporting.',
  outputSchema: {
    type: 'object',
    required: ['summary'],
    properties: { summary: { type: 'string', description: 'A grounded summary' } },
  },
});

res.output?.content.summary; // string
res.output?.grounding;       // [{ field, citations, confidence }]
```

Validation catches the mistakes that otherwise cost a 400: `company`/`people`
with `excludeDomains` or date filters, `additionalQueries` outside the deep
types, `outputSchema` depth and property limits, all seven removed parameters,
and content fields put top-level on `/search` instead of under `contents`.

Full parameter reference — and where Exa's own setup guide diverges from its
docs — in **[docs/exa-api-reference.md](docs/exa-api-reference.md)**.

## Voxell client

```ts
const { embeddings, dim, tokens, cacheHits } = await voxell.embed(
  ['first text', 'second text'],
  { model: 'turbo' },
);
```

| Model | Dimensions | Latency (1 short text) |
|---|---:|---:|
| `turbo` *(default)* | 1024 | ~12 ms |
| `pro` | 2560 | ~59 ms |
| `ultra-4k` | 4096 | ~98 ms |

- **Batches automatically** (128/request, 4 concurrent) and reassembles in
  input order
- **Embeds repeated text once** per request and fans the vector back out
- **Caches by model + text** in memory, so a repeat run costs nothing
- **Vectors are L2-normalized**, so cosine similarity is a dot product
- **Rejects blank strings** before sending — Voxell answers those with a 502
- **Rejects text over 32,000 characters**, or clips it with
  `{ onOversizedText: 'truncate' }`

Voxell publishes no reference docs, so every shape and limit here was measured
against the live API. **[docs/voxell-api-reference.md](docs/voxell-api-reference.md)**
records the findings, including what was *not* established. Re-verify any time:

```bash
VOXELL_LIVE_TEST=1 npm run test:live
```

> One caveat worth knowing: an identical request returns an identical vector,
> but the same text in a *differently shaped batch* can differ by ~6e-4 per
> component (cosine ≥ 0.99998). Irrelevant for ranking; relevant if you were
> planning to hash or equality-check a vector.

## Similarity helpers

```ts
import { cosineSimilarity, topK, centroid, collapseNearDuplicates } from './src/index.js';
```

`cosineSimilarity` · `dot` · `magnitude` · `normalize` · `isNormalized` ·
`centroid` · `topK` · `collapseNearDuplicates` · `canonicalizeUrl` ·
`resultToEmbedText`.

## Errors

Exa errors extend `ExaError`, Voxell errors extend `VoxellError`. Both follow
the same shape: `status`, `requestId`, and the parsed `body` on API errors.

| Concern | Exa | Voxell | Retried |
|---|---|---|---|
| Rejected client-side | `ExaRequestValidationError` | `VoxellRequestValidationError` | — |
| 400 | `ExaBadRequestError` | `VoxellBadRequestError` | no |
| 401 / 403 | `ExaAuthError` | `VoxellAuthError` | no |
| 413 | — | `VoxellPayloadTooLargeError` | no |
| 429 | `ExaRateLimitError` | `VoxellRateLimitError` | yes |
| 5xx | `ExaServerError` | `VoxellServerError` | yes |
| Network | `ExaConnectionError` | `VoxellConnectionError` | yes |
| Timeout | `ExaTimeoutError` | `VoxellTimeoutError` | no |

Retries use exponential backoff with full jitter and honor `Retry-After`.
Configure with `maxRetries` (default 2) and `retryBaseMs` (default 500).

## Project layout

```
src/
  http/transport.ts   shared: timeouts, retry, error mapping
  exa/                Exa client, types, validation, SSE
  voxell/             Voxell embeddings client
  research/           similarity, rerank, dedupe, pipeline
test/
  exa/ voxell/ research/   213 tests — no network, no keys
  live/                    21 tests — opt-in, real Voxell API
examples/             one runnable script per pattern
docs/                 measured API references
```

## Scripts

| Command | Description |
|---|---|
| `npm run check` | Typecheck and test |
| `npm test` | Offline suite (213 tests) |
| `npm run test:live` | Live API tests — needs `VOXELL_LIVE_TEST=1` |
| `npm run typecheck` | Typecheck `src`, `test`, `examples` |
| `npm run build` | Compile to `dist/` |
| `npm run example:research` | **Exa → Voxell pipeline** |
| `npm run example:search` | Exa raw retrieval with highlights |
| `npm run example:structured` | Exa `outputSchema` + grounding |
| `npm run example:contents` | Exa `/contents` and `/answer` |
| `npm run example:stream` | Exa streaming search |

## Reference

- Exa: <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
- Voxell: no public docs — see [docs/voxell-api-reference.md](docs/voxell-api-reference.md)
