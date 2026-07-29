# research-toolkit

A research tool built from three layers: **Exa** for broad retrieval, **Voxell**
embeddings for semantic precision, and a pluggable LLM — **Claude** or
**Fireworks** — for grounded synthesis.

Exa finds candidates. Voxell re-scores every candidate against the actual
question, collapses restatements of the same story, and groups what survives
into themes. The LLM then writes it up with citations that are *checked*, not
trusted.

```
Exa /search ─▶ chunk ─▶ Voxell /v1/embed ─▶ rerank ─▶ dedupe ─▶ cluster ─▶ synthesize
                                  │
                            vector store (memory or disk)
```

- **Typed clients for all three APIs**, mirroring each wire format exactly
- **Validates before it sends** — every rule verified against the live API, not
  taken from the docs, so mistakes fail immediately instead of costing a round
  trip *and* nothing valid gets falsely rejected
- **One shared transport** for Exa and Voxell — timeouts, retry with jitter,
  `Retry-After`, typed errors
- **Cached embeddings**, in memory or on disk, so a repeat run is free
- **Citation checking** — a synthesis that cites a source that doesn't exist is
  reported, not silently returned

**Dependencies:** the Exa, Voxell, and Fireworks clients, the research
pipeline, and the vector stores have **no runtime dependencies** — just Node
20+ native `fetch`. Only the Anthropic completer pulls in `@anthropic-ai/sdk`
(its official SDK); the Fireworks path has none.

## Setup

```bash
cp .env.example .env     # EXA_API_KEY, VOXELL_API_KEY, + ANTHROPIC_API_KEY or FIREWORKS_API_KEY
npm install
npm run check            # typecheck + 349 tests, no network, no keys needed
```

Then a live run:

```bash
npm run example:synthesis "how are teams evaluating RAG retrieval quality?"
npm run example:synthesis -- --provider fireworks "same question, other model"
```

The npm scripts load `.env` via Node's native `--env-file-if-exists`, so there
is no dotenv dependency.

> **Voxell auth:** the header is `Authorization: Bearer <key>`. A bare key
> 401s. See [the reference](docs/voxell-api-reference.md#authentication) — this
> is the most common mistake with that API.

## The research pipeline

```ts
import { ExaClient, VoxellClient, FileVectorStore, researchSearch } from './src/index.js';

const report = await researchSearch(
  new ExaClient(),
  new VoxellClient({ store: new FileVectorStore({ path: '.cache/vectors.jsonl' }) }),
  {
    query: 'how are engineering teams evaluating retrieval quality in RAG systems?',
    numResults: 25,
    chunk: true,
    cluster: true,
    topK: 10,
  },
);
```

What it does, in order:

1. **Search** — Exa, with `contents.text` when chunking, `highlights` otherwise
2. **Drop exact duplicates** — by canonical URL, before spending an embedding
3. **Chunk** *(optional)* — split each page into passages
4. **Embed** — the query and every passage in a single batched request
5. **Rerank** — by cosine similarity; with chunking, a result scores as its
   best-matching passage
6. **Dedupe** — collapse results within `dedupeThreshold` of a higher-ranked one
7. **Filter** — `minScore`, then `topK`
8. **Cluster** *(optional)* — group survivors into themes

| Option | Default | Notes |
|---|---|---|
| `numResults` | 25 | Passed to Exa |
| `search` | `{}` | Any `SearchOptions`, merged over the defaults |
| `model` | client default | `turbo` / `pro` / `ultra-4k` |
| `chunk` | `false` | `true`, or `{ maxChars, overlapChars, minChars }` |
| `dedupe` | `true` | |
| `dedupeThreshold` | `0.92` | Cosine at or above which two results are one story |
| `cluster` | `false` | `true`, or `{ threshold, maxClusters }` |
| `minScore` | — | Drop results below this similarity to the query |
| `topK` | — | Keep the best N after ranking and dedupe |

Each result carries `score`, `originalRank`, `rankDelta` (positive = the rerank
promoted it), absorbed `duplicates`, and — with chunking on — `bestChunk`, the
passage that actually matched. `report.exa` keeps the raw response.

### Chunking

One vector per document caps precision on long pages: a 10,000-word article
with one relevant paragraph averages that paragraph away. Chunking embeds
passages separately so the relevant one scores on its own merits.

Splits prefer paragraph boundaries, then sentence boundaries, and only cut
mid-sentence when a single sentence exceeds the budget. Relevance is the *best*
passage; identity (for dedupe and clustering) stays the whole document, so one
strong paragraph can't make two different articles look like the same story.

Verified live: given a page where a single paragraph is on-topic and the rest
is Kubernetes upgrades and office moves, chunking finds that paragraph and
scores the page higher than whole-document embedding does.

### Tuning the thresholds

Both defaults are calibrated against real article text, not guessed:

| Threshold | Default | Same-signal band | Cross-signal band |
|---|---|---|---|
| `dedupeThreshold` | 0.92 | Restatements of one story: >0.92 | Distinct articles: <0.92 |
| `cluster.threshold` | 0.38 | Same topic: 0.42–0.49 | Different topics: 0.22–0.33 |

Note how much narrower the clustering gap is. Topic similarity is genuinely
fuzzier than duplicate detection, so **treat clusters as a navigation aid, not
ground truth**, and expect to tune per corpus: raise the threshold if unrelated
results get grouped, lower it if an obvious theme fragments.

`test/live/pipeline.live.test.ts` asserts both gaps still exist — those are the
tests that should fail first if Voxell changes models.

## Synthesis

```ts
import { anthropicCompleter, synthesize } from './src/index.js';

const synthesis = await synthesize(report, {
  completer: anthropicCompleter(),
  maxSources: 10,
});

console.log(synthesis.text);          // prose with [n] markers
synthesis.sources;                    // [{ marker, result, score, cited }]
synthesis.invalidMarkers;             // markers citing sources that don't exist
synthesis.uncitedMarkers;             // sources the write-up ignored
```

**The citation check is the point.** A model can emit `[7]` when six sources
exist; `invalidMarkers` catches exactly that. A non-empty array means the
write-up should not be trusted as-is — the example exits non-zero on it.

Synthesis takes a `Completer`, not an SDK client, so prompt construction and
citation checking are testable without a key, and another model can be swapped
in:

```ts
const completer: Completer = async ({ system, prompt }) => ({ text: await myModel(system, prompt) });
```

Two completers ship with the toolkit.

**`anthropicCompleter()`** — defaults to `claude-opus-5` at `high` effort and
opts into **server-side fallbacks**, so a policy-declined request is re-run on a
fallback model in the same call. It checks `stop_reason` before reading content:
a refusal is an HTTP 200 with empty content, and would otherwise look like an
empty answer.

| Option | Default |
|---|---|
| `model` | `claude-opus-5` |
| `effort` | `high` (`low` … `max`) |
| `maxTokens` | 16000 |
| `fallbacks` | `true` |

**`fireworksCompleter()`** — defaults to `accounts/fireworks/models/kimi-k3`.
It throws on a truncated write-up rather than returning one, because a
synthesis cut off mid-sentence can leave dangling citations. Pass
`{ failOnTruncation: false }` to accept partial output.

| Option | Default |
|---|---|
| `model` | `accounts/fireworks/models/kimi-k3` |
| `maxTokens` | 16000 |
| `failOnTruncation` | `true` |
| `temperature` / `topP` / `topK` | unset |

Swapping providers changes nothing else — the prompt, the citation checking,
and the report shape are identical:

```ts
await synthesize(report, { completer: fireworksCompleter() });
```

## Vector stores

Embeddings are cached by model + text. The default is in-memory;
`FileVectorStore` persists across processes so repeat research costs nothing.

```ts
new VoxellClient({ store: new FileVectorStore({ path: '.cache/vectors.jsonl' }) });
```

The file is append-only JSONL with vectors as base64 float32 — ~5× smaller than
JSON numbers, and a torn final line from an interrupted write costs one record,
not the file. Implement `VectorStore` (`getMany` / `setMany` / `clear` / `size`)
to back it with anything else.

> Float32 storage is lossy against the API's float64 JSON. Measured cosine
> between a stored and a fresh vector is >0.9999 — far below any threshold
> here, but don't expect byte equality.

## Exa client

Wraps `/search`, `/contents`, and `/answer`. Field names mirror the raw JSON
API, so anything in the Exa docs passes through unchanged.

Search types, cheapest first: `instant` (~250 ms) · `fast` (~450 ms) · `auto`
(~1 s, default) · `deep-lite` (~4 s) · `deep` (4–15 s) · `deep-reasoning`
(12–40 s). The client sets a per-type timeout with headroom for the synthesis
and livecrawl latency that stacks on top.

For grounded structured output, pass an `outputSchema` — it works on every
search type, and `search<T>()` types `output.content`.

Validation catches the mistakes that otherwise cost a 400: `company`/`people`
with `excludeDomains` or date filters, `additionalQueries` outside the deep
types, `outputSchema` depth and property limits, all seven removed parameters,
and content fields put top-level on `/search` instead of under `contents`.

**The client follows the live API, not the docs, where they disagree** — and
they disagree in five places. Three were rules this client originally enforced,
which meant it rejected requests Exa accepts:

| Docs say | Live API does |
|---|---|
| `company` and `people` both reject `excludeDomains` | Only `people` does |
| `additionalQueries` is deep-types-only | Accepted on every type |
| `numResults` caps at 100 | The cap is plan-dependent |
| Response has `searchType` | It has `resolvedSearchType` (+ `searchTime`) |
| `text.maxCharacters` caps at 10000 | Larger values are fine, not an error |

Full reference, including what the API accepts but silently ignores, in
**[docs/exa-api-reference.md](docs/exa-api-reference.md)**. Re-verify any time:

```bash
EXA_LIVE_TEST=1 npm run test:live
```

## Voxell client

| Model | Dimensions | Latency (1 short text) |
|---|---:|---:|
| `turbo` *(default)* | 1024 | ~12 ms |
| `pro` | 2560 | ~59 ms |
| `ultra-4k` | 4096 | ~98 ms |

- **Batches automatically** (128/request, 4 concurrent), reassembles in order
- **Embeds repeated text once** per request and fans the vector back out
- **Vectors are L2-normalized**, so cosine similarity is a dot product
- **Rejects blank strings** before sending — Voxell answers those with a 502
- **Rejects text over 32,000 characters**, or clips it with
  `{ onOversizedText: 'truncate' }`

Voxell publishes no reference docs, so every shape and limit was measured
against the live API. **[docs/voxell-api-reference.md](docs/voxell-api-reference.md)**
records the findings, including what was *not* established.

```bash
VOXELL_LIVE_TEST=1 npm run test:live   # re-verify any time
```

> An identical request returns an identical vector, but the same text in a
> *differently shaped batch* can differ by ~6e-4 per component (cosine
> ≥0.99998). Irrelevant for ranking; relevant if you planned to hash a vector.

## Fireworks client

OpenAI-compatible chat completions, on the same shared transport as Exa and
Voxell.

```ts
const { text, reasoning, usage } = await new FireworksClient().chat([
  { role: 'user', content: 'Summarize this' },
]);
```

Three things about the API shaped this client, all verified live:

- **`max_tokens: 0` returns HTTP 200 with empty content** and
  `finish_reason: "length"` — a silent empty answer you still pay prompt tokens
  for. Rejected client-side.
- **`finish_reason: "length"` means truncation**, so `chat()` throws by default
  rather than handing back a half-written result nothing downstream can detect.
- **Reasoning models return `reasoning_content` separately**, and its tokens
  are billed inside `completion_tokens` — a two-word answer can cost hundreds
  of tokens. Surfaced as `result.reasoning`.

Model ids are fully qualified (`accounts/fireworks/models/kimi-k3`); a bad one
is a 404, mapped to `FireworksModelNotFoundError` with a pointer to
`GET /v1/models`. `chat()` also accepts multimodal content parts for
vision-capable models.

## Errors

Each provider has its own hierarchy: `ExaError`, `VoxellError`,
`FireworksError`, `SynthesisError`. API errors carry `status`, `requestId`, and
the parsed `body`.

| Concern | Exa | Voxell | Fireworks | Retried |
|---|---|---|---|---|
| Rejected client-side | `ExaRequestValidationError` | `VoxellRequestValidationError` | `FireworksRequestValidationError` | — |
| 400 | `ExaBadRequestError` | `VoxellBadRequestError` | `FireworksBadRequestError` | no |
| 401 / 403 | `ExaAuthError` | `VoxellAuthError` | `FireworksAuthError` | no |
| 404 | — | — | `FireworksModelNotFoundError` | no |
| 413 | — | `VoxellPayloadTooLargeError` | — | no |
| 429 | `ExaRateLimitError` | `VoxellRateLimitError` | `FireworksRateLimitError` | yes |
| 5xx | `ExaServerError` | `VoxellServerError` | `FireworksServerError` | yes |
| Network | `ExaConnectionError` | `VoxellConnectionError` | `FireworksConnectionError` | yes |
| Timeout | `ExaTimeoutError` | `VoxellTimeoutError` | `FireworksTimeoutError` | no |

Synthesis adds `SynthesisRefusedError` (the model's safety classifiers declined
— carries the refusal `category`). Retries use exponential backoff with full
jitter and honor `Retry-After`.

## Project layout

```
src/
  http/transport.ts   shared: timeouts, retry, error mapping
  exa/                Exa client, types, validation, SSE
  voxell/             Voxell embeddings client
  fireworks/          Fireworks chat completions client
  store/              vector stores (memory, file)
  research/           chunk, similarity, rerank, dedupe, cluster, pipeline
  synthesis/          Completer interface + Anthropic/Fireworks adapters + citation checks
test/
  exa/ voxell/ fireworks/ store/ …           349 tests — no network, no keys
  live/                                       57 tests — opt-in, real APIs
examples/             one runnable script per pattern
docs/                 measured API references
```

## Scripts

| Command | Description |
|---|---|
| `npm run check` | Typecheck and test |
| `npm test` | Offline suite (349 tests) |
| `npm run test:live` | Live API tests — gated per provider by `EXA_LIVE_TEST` / `VOXELL_LIVE_TEST` / `FIREWORKS_LIVE_TEST` |
| `npm run build` | Compile to `dist/` |
| `npm run example:synthesis` | **Full pipeline + grounded write-up** |
| `npm run example:research` | Exa → Voxell rerank and dedupe |
| `npm run example:search` | Exa raw retrieval with highlights |
| `npm run example:structured` | Exa `outputSchema` + grounding |
| `npm run example:contents` | Exa `/contents` and `/answer` |
| `npm run example:stream` | Exa streaming search |

## Reference

- Exa: <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
- Voxell: no public docs — see [docs/voxell-api-reference.md](docs/voxell-api-reference.md)
- Claude: <https://platform.claude.com/docs>
- Fireworks: <https://docs.fireworks.ai>
