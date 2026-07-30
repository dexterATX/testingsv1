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
npm run check            # typecheck + 402 tests, no network, no keys needed
```

Then either the web UI:

```bash
npm run web          # → http://127.0.0.1:4317
```

or the CLI:

```bash
npm run example:synthesis "how are teams evaluating RAG retrieval quality?"
npm run example:synthesis -- --provider fireworks "same question, other model"
```

The npm scripts load `.env` via Node's native `--env-file-if-exists`, so there
is no dotenv dependency.

> **Voxell auth:** the header is `Authorization: Bearer <key>`. A bare key
> 401s. See [the reference](docs/voxell-api-reference.md#authentication) — this
> is the most common mistake with that API.

## Web UI

```bash
npm run web
```

A local page for running research and watching it happen. The pipeline runs
server-side and streams each stage over SSE, so **Exa's raw hits are on screen
seconds before the ranking finishes** — you can start reading links while the
embeddings are still in flight.

Sections fill in as the run progresses:

1. **Pipeline** — each stage with live counts (results, passages, tokens, cache hits)
2. **What the search returned** — the unmodified hit list, in the order Exa gave it
3. **After reranking & dedupe** — scores, rank movement (`↑9`), the matching
   excerpt, and which sources were collapsed into each result
4. **Themes** — real groups only, and nothing at all when the results have no group structure (which is common)
5. **Write-up** — the synthesis, with `[n]` markers linked to their sources

Fabricated citations are called out in red rather than quietly rendered.

Two options widen a run beyond one search: *Also search for*, one query per
line, and *Write the extra searches for me*, which generates three. Both feed
the same fan-out and both are capped at eight extra searches between them, with
what you typed taking priority — every one is another paid search.

**Keys never reach the browser.** The page talks only to localhost; the server
holds the credentials and sends back results. It binds to `127.0.0.1` for that
reason — override with `HOST` only if you understand the exposure. Closing the
tab aborts the in-flight run.

**Provider names never reach it either.** The UI describes stages, not vendors:
`/api/config` answers in capabilities (`search`, `embeddings`, `writers`), the
write-up backends are offered as opaque ids (`writer-a`, `writer-b`) labelled
*Default* / *Alternate*, and the model fields are stripped from the SSE stream
rather than merely left unrendered. Error messages get the same treatment —
the operator's console sees `Missing Exa API key`, the page sees `Missing
search API key`. See [`src/server/redact.ts`](src/server/redact.ts) for why
that is enforced at the server and not in the page.

| Variable | Default | |
|---|---|---|
| `PORT` | `4317` | |
| `HOST` | `127.0.0.1` | Anything else prints a warning — see below |
| `CACHE_PATH` | `<repo>/.cache/vectors.jsonl` | Anchored to the repo, not the working directory |

## Deploying it to a server

```bash
sudo bash deploy/hostinger.sh
```

Written for a Hostinger VPS (Debian 13 / Ubuntu 24.04) but there is nothing
Hostinger-specific in it — any systemd box works. It installs Node 22 if
needed, clones and builds into `/opt/research-toolkit` as an unprivileged
user, writes the keys to `/etc/research-toolkit.env` (root, mode 600), and
installs a hardened systemd unit bound to `127.0.0.1`.

It assumes the box is **already doing something**. It never edits a web server
config it did not write, refuses a port that is taken, and every step is
idempotent. When Caddy is already installed it adds one file under
`conf.d/` — and if that file fails to validate (most likely because the site
address is already served) it deletes it again and leaves the running config
untouched, so a failed deploy cannot take a live site down with it.

| Variable | Default | |
|---|---|---|
| `PUBLIC_PORT` | `443` | Use another to sit alongside an existing site rather than collide with it. ACME still validates over port 80, so the certificate is real either way. |
| `PUBLIC_HOSTNAME` | `hostname -f` | The name on the certificate |
| `UI_AUTH` | `password` | `none` leaves it open to anyone with the URL |
| `UI_USER` / `UI_PASSWORD` | `research` / generated | Printed once on success |
| `APP_PORT` | `4317` | Localhost only; the proxy is the only public listener |

```bash
# alongside an existing site, on a second port, with a login
sudo PUBLIC_PORT=8443 bash deploy/hostinger.sh
```

### Updating a deployment

The same command. It fetches the branch, rebuilds, and restarts the unit:

```bash
sudo bash deploy/hostinger.sh
```

Your keys are kept — an existing `/etc/research-toolkit.env` is never
rewritten, so nothing is re-typed. The port and login choices are kept too:
they are recorded in `/etc/research-toolkit.deploy` and used as the defaults
next time, because otherwise a routine update would move a site deployed on
8443 back to 443 and put a password in front of one deliberately left open.
Passing a variable still overrides the remembered value.

Re-running with `UI_AUTH=password` and no `UI_PASSWORD` generates a *new*
password and prints it. Pass `UI_PASSWORD` to keep the old one.

**The default is a password**, because the page has no login of its own and the
process holds live API keys: an open URL means every visitor spends them, and
hostnames on shared provider domains get scanned. `UI_AUTH=none` is a supported
choice rather than an accident — the script takes it and says plainly what it
did. The same reasoning drives the startup warning when `HOST` is not
localhost.

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

1. **Search** — Exa, plus any `extraSearches`, merged
2. **Drop exact duplicates** — by canonical URL, before spending an embedding
3. **Chunk** *(optional)* — split each page into passages
4. **Embed** — the query and every passage in a single batched request
5. **Rerank** — by cosine similarity; with chunking, a result scores as its
   best-matching passage
6. **Dedupe** — collapse results within `dedupeThreshold` of a higher-ranked one
7. **Cap per domain** — demote a publisher's fourth entry and beyond
8. **Filter** — `minScore`
9. **Hydrate** — fetch full text for the top `hydrateTopK`, chunk it, re-score
   those by best passage
10. **`topK`**
11. **Cluster** *(optional)* — group survivors into themes

The order is not arbitrary. Dedupe, the domain cap and `minScore` are cheap
filters and hydration is the expensive step, so every filter sits upstream of
it. More importantly, **dedupe and clustering only ever see first-pass
vectors** — see *Hydration* below for why mixing the two passes would quietly
break both.

| Option | Default | Notes |
|---|---|---|
| `numResults` | 25 | Passed to Exa. Capped by your plan — 100 on the measured account |
| `extraSearches` | `[]` | More searches, merged before ranking. The only way past the per-request cap |
| `search` | `{}` | Any `SearchOptions`, merged over the defaults — `contents` per key, not wholesale |
| `model` | `ultra-4k` | `turbo` (free) / `pro` / `ultra-4k`; or set `VOXELL_MODEL` |
| `chunk` | `false` | `true`, or `{ maxChars, overlapChars, minChars }` |
| `dedupe` | `true` | |
| `dedupeThreshold` | per model | Cosine at or above which two results are one story — see below |
| `maxPerDomain` | 3 | Entries one host may hold before the rest are demoted. `0` disables |
| `hydrate` | `true` | Re-score the top results on their full text |
| `hydrateTopK` | 25 | How far down that second pass reaches. Must be ≥ `topK` |
| `topChunks` | 4 | Passages kept per hydrated result, for the write-up |
| `cluster` | `false` | `true`, or `{ threshold, maxClusters }` |
| `minScore` | — | Drop results below this similarity to the query |
| `topK` | — | Keep the best N after ranking and dedupe |

Each result carries `score`, `originalRank`, `rankDelta` (positive = the rerank
promoted it), absorbed `duplicates`, and — where chunking or hydration ran —
`bestChunk`, the passage that actually matched, plus `topChunks`, the best few
in document order. `report.exa` keeps the raw response.

Pass `onEvent` to observe stages as they finish rather than waiting for the
whole run — this is what the web UI streams:

```ts
await researchSearch(exa, voxell, {
  query,
  onEvent: (event) => {
    if (event.type === 'search:done') console.log(`${event.results.length} hits`);
  },
});
```

A throwing handler is swallowed: a broken progress listener never fails the run.

### Getting more results than one search returns

Exa caps `numResults` at whatever your plan allows — **100** on the measured
account, with `NUM_RESULTS_EXCEEDED` above it — and there is **no pagination**.
`offset`, `page`, `cursor` and friends are accepted and silently ignored,
returning the identical window every time. Verified: offsets 0, 10 and 50 give
the same three URLs.

So the only way to widen recall is more searches, which `extraSearches` merges
into one run:

```ts
await researchSearch(exa, voxell, {
  query: 'how are teams evaluating RAG retrieval quality?',
  numResults: 50,
  extraSearches: [
    { query: 'measuring retriever precision in production RAG' },
    { query: 'RAG evaluation metrics: recall@k, MRR, golden datasets' },
    { startPublishedDate: '2024-01-01T00:00:00.000Z',
      endPublishedDate:   '2025-06-01T00:00:00.000Z' },
  ],
});
```

Measured yield on one question, 50 results per search:

| Strategy | Raw | Unique | Overlap |
|---|---|---|---|
| 5 paraphrases | 250 | 211 | 16% |
| 3 disjoint date windows | 150 | 150 | **0%** |

Overlap costs nothing past the search itself — exact-URL dedupe runs before
anything is embedded — and **ranking stays anchored to the original `query`**,
so a paraphrase widens the net without steering the order. End to end, a 4-way
fan-out took one question from 50 results to 170, put two entries in the top
ten that the single search never saw, and left the top score unchanged.

The web UI exposes this as *Also search for*, one query per line.

#### Writing the paraphrases automatically

`extraSearches` has always worked. What it lacked was anyone to type into it —
nobody rephrases their own question four ways. `expandQuery` does it:

```ts
import { expandQuery, fireworksCompleter } from './src/index.js';

const extras = await expandQuery(query, { completer: fireworksCompleter(), count: 3 });

await researchSearch(exa, voxell, {
  query,                                        // ranking still uses this
  extraSearches: extras.map((q) => ({ query: q })),
});
```

It takes a `Completer`, not an SDK client, so **`researchSearch` stays free of
any LLM dependency** — callers without a write-up key can still search, and the
prompt and validation are testable with a stub. Run it first, pass the result
in as ordinary extra searches.

Measured, three generated queries against the plain single search:

| Question | Unique results | New in top 10 | Embedding tokens |
|---|---|---|---|
| RAG retrieval evaluation | 25 → 94 | **4**, including #1 | 114k → 146k (1.3×) |
| AI app builders 2026 | 25 → 98 | **6**, including #2 | 83k → 118k (1.4×) |

That is not extra recall going unread at the bottom of the list — on the second
question expansion supplied more than half of what the user actually sees.

**Validation matters more than the prompt.** A model that answers in prose must
degrade to no expansion, never to a paid search for a sentence of commentary,
so `parseExpansions` drops headings, restatements of the original, duplicates
and anything too long to be a query. It also salvages: the same model on the
same prompt returned three bare lines on one call and
`1. **"…"** — for security guidelines` on the next, and rejecting the second
would leave the feature working on a coin flip.

`expandQuery` returns `[]` on any failure. Pass `onError` to find out why —
otherwise a timeout and a badly-behaved model look identical, and both look
like a feature that does nothing.

In the web UI this is *Write the extra searches for me*, and the queries it
generated appear in the progress list — a bad expansion is only visible if you
can see what it searched for.

Note that the deep search types go the other way: `deep` and `deep-lite`
returned 14 and 16 results against `fast`/`instant`'s 100. They do agentic
multi-step research, not broad retrieval.

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

### Hydration

Chunking every result costs roughly ten times the embedding tokens, most of it
spent on results nobody reads. Hydration buys the same precision where it
matters: rank everything on the search engine's highlights, then fetch full
text for the top `hydrateTopK` survivors, chunk *those*, and re-score them by
best passage.

Measured over four questions, 30 results each: **8–10 of the top ten changed
position**, at 5.8–7.0× the embedding tokens. Longer documents get more chunks
and so more chances to score, which would be a length bias — checked, and it
isn't one: correlation between document length and passage score was **−0.07**
over 75 results.

Two constraints make it safe, and both are load-bearing:

- **Hydration changes `score` only, never `identity`.** Highlights are excerpts
  the search engine selected *against the query*; a full-text centroid points
  at the document's own centre of mass. They are not the same distribution, and
  `thresholds.ts` is calibrated on the first. Letting hydrated results carry
  full-text identity would stop dedupe working for exactly the highest-ranked
  results, and clustering — which runs on `identity` — would group *by whether
  a result was hydrated* and present that as a theme. The same documents
  composed two ways already differ by 0.089 cosine, measured.
- **Re-ranking happens inside the K block only.** First- and second-pass scores
  are not on one scale, and the bias has unknown sign: max-over-chunks inflates
  the second pass mechanically, while highlights are already a near-best-case
  excerpt. Block membership is decided by first-pass scores alone and every
  member is hydrated, so no cross-scale comparison ever happens. The cost is a
  hard discontinuity at the block edge — hence `topK > hydrateTopK` is rejected
  rather than silently mixing the two.

`score` keeps the first-pass number; the second-pass one is `passageScore`.
`minScore` is applied before hydration, on the scale the caller chose it for.

A failed fetch is not a dropped result — Exa reports per-URL failures in
`statuses` rather than throwing, and anything it could not fetch keeps its
first-pass score and follows the hydrated block.

### Spreading the publishers

`maxPerDomain` (default 3) demotes a host's fourth entry and beyond to the tail
of the list, after near-duplicate dedupe. Near-duplicate dedupe compares
*content*, and three different pages from one vendor are not textually
near-duplicate — they are one voice, repeated, and the site that publishes most
wins.

Honest about what this is: **insurance, not a measured win.** Across eight
variations of the comparison question that motivated it, the top ten already
held ten distinct domains every time, so the cap never engaged. It costs
relevance where one site really is the authority — an API's own documentation —
which is why the default is permissive and `0` turns it off. `stats.demotedByDomain`
reports when it fires.

### Tuning the thresholds

**A threshold belongs to the embedding model, not to the task.** Each model
puts "the same story" and "the same topic" at different points on the cosine
scale, so `src/research/thresholds.ts` keys them by model and the pipeline
picks the right pair for whichever model is running.

Measured through the pipeline's own text path over 45 results:

| Model | True duplicate | Different articles, same topic | `dedupe` default |
|---|---|---|---|
| `ultra-4k` *(default)* | 0.980 | 0.823–0.895, max 0.908 | **0.94** |
| `turbo` | 0.986 | 0.925–0.945, max 0.948 | **0.95** |

Both models separate the two cases, but `ultra-4k` leaves a 0.072 gap against
turbo's 0.038 — which is the concrete reason it is the default. An earlier
single default of 0.92 sat *inside* turbo's non-duplicate band, so distinct
articles that merely shared a topic were being collapsed into each other.

Verified both ways: on a syndicated news story both models collapse four real
duplicates at 0.979–0.995, and on twenty distinct articles about one topic
neither collapses anything.

`pro` is deliberately **not** in the table. Interpolating a number from its
neighbours would look like a measurement and would not be one, so it falls
through to a conservative default until somebody measures it.

**Clustering only reports actual groups.** A single cluster holding every
result is the result list printed twice, and a crowd of one-member "themes" is
no grouping at all — both are what agglomerative clustering returns for a
continuum, and one query's worth of web results usually is one. So groups of
two or more are reported and everything else is dropped; an empty list means
"no theme structure here", which is true, where a lone all-inclusive theme
would be misleading. Expect no themes on a focused question and a few on a
deliberately broad one.

**Its threshold remains a compromise rather than a measurement.** The pairwise distribution moves a long way with the query: on
a tightly-focused question every result sits between 0.67 and 0.95, while on a
deliberately broad one nothing pairs above 0.78 and every result is its own
theme. No single constant is right for both. Treat clusters as a navigation
aid, not ground truth. Fixing it properly means clustering at a percentile of
the observed similarities rather than a constant — a design change, not a
retune.

`test/research/thresholds.test.ts` pins every `dedupe` value between its
model's measured bands, so a change that would resume over-collapsing fails
the offline suite.

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

Each source is quoted from its `topChunks` — the passages that actually matched
the question, not the first 1200 characters of the page. Three details make
that worth doing rather than merely longer:

- **Document order, not score order.** A write-up built from excerpts shuffled
  by relevance argues backwards.
- **`[…]` between non-adjacent passages.** Two excerpts from opposite ends of a
  page, run together, read as one continuous claim the source never made.
- **Consecutive passages are de-overlapped.** Chunks are cut with 150
  characters of overlap; quoting the boundary twice wastes budget and reads as
  emphasis the source never gave. The overlap is measured, not assumed.

`evidenceChars` (default 4200) is a per-source budget, and it stops on a whole
passage rather than tailing off mid-sentence — a fragment too short to carry a
claim still costs tokens and invites a citation to nothing. At default chunk
sizes that admits about three of the four passages `topChunks` retains; raise
it if you would rather pay for the fourth.

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
npm run test:live   # re-verify any time (set VOXELL_LIVE_TEST=1 in .env)
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
  server/             local HTTP server + SSE progress stream
web/                  the UI (plain HTML/CSS/JS, no build step)
test/
  exa/ voxell/ fireworks/ server/ store/ …   402 tests — no network, no keys
  live/                                       57 tests — opt-in, real APIs
examples/             one runnable script per pattern
docs/                 measured API references
```

## Scripts

| Command | Description |
|---|---|
| `npm run check` | Typecheck and test |
| `npm test` | Offline suite (402 tests) |
| `npm run test:live` | Live API tests — reads `.env`; gated per provider by `EXA_LIVE_TEST` / `VOXELL_LIVE_TEST` / `FIREWORKS_LIVE_TEST` |
| `npm run web` | **Local research UI** on http://127.0.0.1:4317 |
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
