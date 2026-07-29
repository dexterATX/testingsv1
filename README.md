# exa-client

A typed, dependency-free TypeScript client for the [Exa](https://exa.ai) search API.

Wraps `/search`, `/contents`, and `/answer`. Field names mirror the raw JSON API
exactly (camelCase), so anything in the Exa docs can be passed straight through
without a translation layer.

- **No runtime dependencies** — native `fetch` on Node 20+
- **Validates before it sends** — documented constraints (result counts, category
  filter incompatibilities, `outputSchema` limits, deprecated parameters) are
  checked client-side, so mistakes fail immediately instead of costing a round
  trip and a 400
- **Typed errors with automatic retry** on 429 / 5xx / network failures, honoring
  `Retry-After`
- **Streaming** via `stream: true` (SSE)

## Setup

### 1. Get an API key

From the [Exa dashboard](https://dashboard.exa.ai).

### 2. Configure it

```bash
cp .env.example .env
# then edit .env and set EXA_API_KEY
```

`.env` is gitignored. Or export it directly:

```bash
export EXA_API_KEY="YOUR_API_KEY"
```

### 3. Install and verify

```bash
npm install
npm run check     # typecheck + tests (no network, no key needed)
```

### 4. Make a live call

```bash
npm run example:search
```

The npm scripts load `.env` via Node's native `--env-file-if-exists`, so no
dotenv dependency is involved.

## Usage

```ts
import { ExaClient } from './src/index.js';

const exa = new ExaClient(); // reads EXA_API_KEY from the environment

const response = await exa.search('best open source vector databases', {
  type: 'auto',
  numResults: 10,
  contents: { highlights: true },
});

for (const result of response.results) {
  console.log(result.title, result.url);
  console.log(result.highlights);
}
```

### Pick your search pattern

**1. Raw retrieval** — when your code inspects `results` directly, feeds
`highlights` into your own LLM, or exposes Exa as a tool in an existing agent
loop. This is the right default.

```ts
await exa.search('your search query here', {
  type: 'auto',
  numResults: 10,
  contents: { highlights: true },
});
```

**2. Synthesized output** — when you want Exa to return a grounded answer or a
structured payload. `systemPrompt` steers source preference and dedupe behavior;
`outputSchema` sets the shape of `output.content`.

```ts
interface Report {
  summary: string;
}

const response = await exa.search<Report>('your search query here', {
  type: 'deep',
  systemPrompt: 'Prefer official sources, collapse duplicate reporting.',
  outputSchema: {
    type: 'object',
    required: ['summary'],
    properties: {
      summary: { type: 'string', description: 'A grounded summary of the findings' },
    },
  },
  contents: { highlights: true },
});

response.output?.content.summary; // typed as string
response.output?.grounding;       // [{ field, citations, confidence }]
```

The generic parameter on `search<T>()` types `output.content`. Field-level
citations come back in `output.grounding` automatically — don't add citation or
confidence fields to the schema.

### Search types

`outputSchema` works on every type, so you can request structured output
regardless of which you pick.

| Type | Best for | Approx latency | Client timeout |
|------|----------|----------------|----------------|
| `instant` | Chat, voice, autocomplete | ~250 ms | 15 s |
| `fast` | Latency-sensitive, still good relevance | ~450 ms | 15 s |
| `auto` *(default)* | Most queries | ~1 s | 30 s |
| `deep-lite` | Cheaper synthesis | ~4 s | 60 s |
| `deep` | Research, enrichment, thorough results | 4–15 s | 120 s |
| `deep-reasoning` | Multi-step reasoning, hard synthesis | 12–40 s | 240 s |

Latencies are ballpark base figures — synthesis (`outputSchema`) and forced
livecrawls (`contents.maxAgeHours: 0`) stack on top. The client's default
timeouts already leave headroom for that; override per call with `timeoutMs`.

`additionalQueries` forces explicit query angles and is accepted only on the
three deep types. The client rejects it elsewhere rather than letting the API
400.

### Content modes

Pick **one** of `text`, `highlights`, or `summary` by default. Combining them is
usually an antipattern at the start of a project — it multiplies token cost for
largely redundant content.

```ts
contents: { highlights: true }                              // token-efficient excerpts
contents: { text: { maxCharacters: 8000 } }                 // full extraction, RAG
contents: { summary: { query: 'what changed in v3?' } }     // LLM-written per result
```

`text` also takes `verbosity` (`compact` — the default, main content only —
plus `standard` and `full`), `includeHtmlTags` (preserves code blocks and
tables), and `includeSections` / `excludeSections`. Always set `maxCharacters`
when requesting text; uncapped `text: true` is the usual way to blow up a
context window.

**Case convention:** raw JSON and this client use camelCase (`maxCharacters`).
Only the Python SDK uses snake_case. Passing `max_characters` is silently
ignored by the API, so the client rejects it with an explicit error.

### Content freshness

`maxAgeHours` sets how old cached content may be before Exa livecrawls:

| Value | Behavior |
|-------|----------|
| `24` | Use cache if crawled within 24 h, else livecrawl |
| `0` | Always livecrawl — adds latency |
| `-1` | Never livecrawl, cache only — fastest |
| *(omit)* | Livecrawl only as a fallback — **recommended** |

Cached data is fine for historical and educational topics, which rarely change.

### Domain filtering

Usually unnecessary — neural search finds relevant results without it. Reach for
it to target authoritative sources or exclude low-quality domains.

```ts
{ includeDomains: ['arxiv.org', 'github.com'], excludeDomains: ['pinterest.com'] }
```

They combine, which lets you include a broad domain while excluding a subdomain
(`includeDomains: ['vercel.com']` with `excludeDomains: ['community.vercel.com']`).

The `company` and `people` categories reject `excludeDomains` and both date
filters with a 400. The client catches that combination before sending.

### `/contents` — URLs you already have

```ts
const contents = await exa.contents(['https://example.com/article'], {
  highlights: true,
  maxAgeHours: 24,
});

for (const status of contents.statuses ?? []) {
  if (status.status === 'error') console.warn(status.id, status.error?.tag);
}
```

A URL that can't be fetched is reported in `statuses` rather than throwing —
check it before assuming every input produced a result.

> On `/contents`, `text` / `highlights` / `summary` are **top-level**. On
> `/search` the same fields nest under `contents`. This is the most common
> mix-up between the two endpoints; the client enforces both shapes.

### `/answer` — question-first UIs

```ts
const { answer, citations } = await exa.answer('What is the latest valuation of SpaceX?');
```

For new structured flows, prefer `/search` with an `outputSchema` — you get
grounded output *and* the raw results. Keep `/answer` for cases where you never
need to inspect results.

### Streaming

```ts
import { streamText } from './src/index.js';

for await (const text of streamText(exa.searchStream('your query'))) {
  process.stdout.write(text);
}
```

Iterate `searchStream()` directly instead of through `streamText` if you also
need the results and grounding Exa attaches to chunks as they resolve.

### Errors

All errors extend `ExaError`.

| Class | Cause | Retried |
|-------|-------|---------|
| `ExaRequestValidationError` | Rejected client-side, before sending | — |
| `ExaBadRequestError` | 400 — invalid params or filter combination | no |
| `ExaAuthError` | 401 / 403 — missing or invalid key | no |
| `ExaUnprocessableError` | 422 — parameter type validation | no |
| `ExaRateLimitError` | 429 — carries `retryAfterSeconds` | yes |
| `ExaServerError` | 5xx | yes |
| `ExaConnectionError` | Network failure | yes |
| `ExaTimeoutError` | Exceeded the request timeout | no |

API errors carry `status`, `requestId`, and the parsed `body` — quote the
`requestId` when reporting an issue to Exa.

```ts
import { ExaRateLimitError } from './src/index.js';

try {
  await exa.search('query');
} catch (error) {
  if (error instanceof ExaRateLimitError) {
    console.error(`rate limited; retry after ${error.retryAfterSeconds}s`);
  }
}
```

Retries use exponential backoff with full jitter and honor `Retry-After` when
the API sends it. Configure with `maxRetries` (default 2) and `retryBaseMs`
(default 500).

### Client options

```ts
new ExaClient({
  apiKey,        // defaults to process.env.EXA_API_KEY
  baseUrl,       // defaults to process.env.EXA_BASE_URL or https://api.exa.ai
  timeoutMs,     // overrides the per-search-type defaults
  maxRetries,    // default 2
  retryBaseMs,   // default 500
  headers,       // extra headers on every request
  fetch,         // injectable, for tests
  sleep,         // injectable, for tests
});
```

`search`, `contents`, and `answer` each also accept per-call `signal` and
`timeoutMs`.

## Project layout

```
src/
  client.ts      ExaClient — requests, retries, timeouts
  validate.ts    client-side constraint checks
  types.ts       request/response types
  errors.ts      error classes
  stream.ts      SSE parsing
  index.ts       public exports
test/            vitest suite — 114 tests, no network access and no key needed
                 (unit tests use a fetch stub; integration.test.ts runs the
                 real fetch path against a localhost stub server)
examples/        runnable scripts, one per usage pattern
docs/            API reference notes
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run check` | Typecheck and test |
| `npm test` | Vitest suite |
| `npm run typecheck` | Typecheck `src`, `test`, and `examples` |
| `npm run build` | Compile to `dist/` |
| `npm run example:search` | Raw retrieval with highlights |
| `npm run example:structured` | `outputSchema` + grounding |
| `npm run example:contents` | `/contents` and `/answer` |
| `npm run example:stream` | Streaming search |

## Reference

Canonical source of truth:
<https://exa.ai/docs/reference/search-api-guide-for-coding-agents>

See [`docs/exa-api-reference.md`](docs/exa-api-reference.md) for the full
parameter reference this client encodes, plus notes on where the docs and the
setup guide diverge.
