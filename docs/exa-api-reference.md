# Exa API reference

Parameter reference this client encodes, checked against the canonical docs and
then **verified against the live API** on 2026-07-29.

**Source of truth:** <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>

> ⚠️ **The live API and the docs disagree in several places.** Where they do,
> this client follows the live API. See
> [Where the docs and the live API diverge](#where-the-docs-and-the-live-api-diverge)
> — three of those divergences were rules this client originally enforced,
> which meant it rejected requests Exa accepts. `test/live/exa.live.test.ts`
> asserts each one so drift is caught:
>
> ```bash
> EXA_LIVE_TEST=1 npm run test:live
> ```

> Note: `https://docs.exa.ai/reference/...` 307-redirects to
> `https://exa.ai/docs/reference/...`. Both work; the latter is canonical.

Supporting pages:

- [`/contents`](https://exa.ai/docs/reference/get-contents)
- [`/answer`](https://exa.ai/docs/reference/answer)

---

## `POST /search`

| Parameter | Type | Notes |
|-----------|------|-------|
| `query` | string | **Required.** Accepts long, semantically rich descriptions. |
| `type` | string | `auto` (default), `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning`. |
| `numResults` | integer | Minimum 1, default 10. The ceiling is **plan-dependent**, not a fixed 100. |
| `category` | string | `company`, `people`, `publication`, `news`, `personal site`, `financial report`. |
| `userLocation` | string | Two-letter ISO country code. |
| `includeDomains` | string[] | Max 1200 entries. Supports `*.subdomain.com` wildcards. |
| `excludeDomains` | string[] | Max 1200 entries. **Rejected for `people` only** — `company` accepts it, despite the docs. |
| `startPublishedDate` | string | ISO 8601. **Rejected for `company` / `people`.** |
| `endPublishedDate` | string | ISO 8601. **Rejected for `company` / `people`.** |
| `moderation` | boolean | Filters unsafe content. |
| `additionalQueries` | string[] | Forced query angles. Documented as deep-only, but **accepted on every type**. |
| `systemPrompt` | string | Steers synthesis and search planning. |
| `outputSchema` | object | JSON Schema for `output.content`. Max depth 2, max 10 properties. |
| `compliance` | string | Enterprise-only; `"hipaa"`. |
| `stream` | boolean | Switches to SSE with OpenAI-compatible chunks. |
| `contents` | object | See below. |

### `contents`

```jsonc
{
  "text":       true,       // or { maxCharacters, includeHtmlTags, verbosity, includeSections, excludeSections }
  "highlights": true,       // or { query, maxCharacters }
  "summary":    true,       // or { query, schema }
  "maxAgeHours": 24,        // -1 to 720
  "livecrawlTimeout": 10000, // 0 to 90000 ms, default 10000
  "subpages": 0,            // 0 to 100
  "subpageTarget": "pricing",
  "extras": { "links": 5, "imageLinks": 5, "richLinks": 5, "richImageLinks": 5, "codeBlocks": 5 }
}
```

- `text.maxCharacters` — documented range 1–10000.
- `text.verbosity` — `compact` (default), `standard`, `full`.
- `text.includeSections` / `excludeSections` — `header`, `navigation`, `banner`,
  `body`, `sidebar`, `footer`, `metadata`.
- `highlights.maxCharacters` — documented range 1–10000.

### `maxAgeHours`

| Value | Behavior |
|-------|----------|
| positive | Use cache if crawled within N hours, else livecrawl |
| `0` | Always livecrawl (ignores cache; adds latency) |
| `-1` | Never livecrawl (cache only; fastest) |
| omitted | Livecrawl only as a fallback — recommended |

### Response

```jsonc
{
  "requestId": "string",
  "resolvedSearchType": "string",   // NOT `searchType` — see divergences below
  "searchTime": 360.8,              // undocumented; server-side ms
  "results": [{
    "title": "string", "url": "string", "id": "string",
    "publishedDate": "ISO 8601|null", "author": "string|null",
    "image": "string", "favicon": "string",
    "text": "string",            // if requested
    "highlights": ["string"],    // if requested
    "highlightScores": [0.91],
    "summary": "string",         // if requested
    "subpages": [], "extras": { "links": ["string"] }
  }],
  "output": {                    // only when outputSchema was supplied
    "content": "string|object",
    "grounding": [{ "field": "string", "citations": [{"url": "…", "title": "…"}], "confidence": "low|medium|high" }]
  },
  "costDollars": { "total": 0.005 }
}
```

---

## `POST /contents`

Takes `urls` **or** `ids` (1–100 entries, each ≤ 2048 chars).

**Content fields are top-level here**, not nested under `contents` — the
opposite of `/search`. Same sub-options otherwise (`text`, `highlights`,
`summary`, `extras`, `maxAgeHours`, `livecrawlTimeout`, `subpages`,
`subpageTarget`, `compliance`).

Response adds a `statuses` array alongside `results`:

```jsonc
{
  "id": "string",
  "status": "success | error",
  "source": "cached | crawled",
  "error": { "tag": "CRAWL_NOT_FOUND", "httpStatusCode": 404 }
}
```

A URL that fails to crawl is reported here rather than failing the request.

---

## `POST /answer`

| Parameter | Type | Notes |
|-----------|------|-------|
| `query` | string | **Required.** |
| `text` | boolean | Include full page text on citations. Default false. |
| `outputSchema` | object | Returns a structured `answer` instead of prose. |
| `stream` | boolean | SSE. |

Response: `{ requestId, answer, citations[], costDollars }`, where `citations`
are result objects (`title`, `url`, `id`, `publishedDate`, `author`, `image`,
`favicon`, optional `text`).

---

## Error codes

| Status | Meaning | Client class | Retried |
|--------|---------|--------------|---------|
| 400 | Invalid parameters or unsupported filter | `ExaBadRequestError` | no |
| 401 | Missing/invalid API key | `ExaAuthError` | no |
| 422 | Parameter type validation failure | `ExaUnprocessableError` | no |
| 429 | Rate limited | `ExaRateLimitError` | yes |
| 5xx | Server error | `ExaServerError` | yes |

---

## Where the docs and the live API diverge

Every row below was verified twice against the live API on 2026-07-29. The
first three were rules this client enforced, and enforcing them was a bug: it
rejected requests Exa accepts.

| # | Docs say | Live API does | Client now |
|---|---|---|---|
| 1 | `company` and `people` both reject `excludeDomains` | **Only `people` rejects it.** `company` + `excludeDomains` → 200 | Allows `company` + `excludeDomains` |
| 2 | `additionalQueries` is deep-types-only | **Accepted on every type**, including `auto` | No longer rejects it |
| 3 | `numResults` range is 1–100 | Minimum 1 is enforced; the ceiling is **plan-dependent** (`"above what your plan allows"`) | Validates ≥ 1 only, no ceiling |
| 4 | Response carries `searchType` | Carries **`resolvedSearchType`** (often `""`) plus an undocumented `searchTime` | Types `resolvedSearchType` + `searchTime` |
| 5 | `text.maxCharacters` range is 1–10000 | Values above 10000 are accepted, not an error — you simply get whatever text exists | Validates ≥ 1 only |

Date filters behave as documented: `company` and `people` both reject
`startPublishedDate` and `endPublishedDate` with a 400.

### What the API accepts but silently ignores

These do **not** error, which is precisely why the client rejects them — a
silent no-op on a paid search is worse than an error:

| Passed | Result |
|---|---|
| `text` / `highlights` / `summary` at the top level of `/search` | 200, and **no content is returned** |
| `useAutoprompt`, `livecrawl`, `numSentences`, `tokensNum`, `includeUrls`, … | 200, silently dropped |
| Any unknown key at all (e.g. `totallyMadeUpParameter`) | 200, silently dropped |
| `type: "neural"` (an undocumented legacy value) | 200 — but `type: "totally-made-up"` → 400 |

The client's allowlist of search types is therefore **stricter than the API**:
it rejects undocumented-but-working values like `neural` in exchange for
catching typos before they cost a search. That is a deliberate client-side
choice, not an API rule.

### Verified as documented

`/contents` reports per-URL outcomes in `statuses` rather than throwing (a bad
domain yields `status: "error"` with a `tag`); `/answer` returns prose plus
citations; `outputSchema` works on non-deep types and returns `output.content`
with `output.grounding`. Note that grounding `field` paths are coarser than the
docs example suggests — `"companies"` rather than `"companies[0].name"`.

## Removed / nonexistent parameters

All of these are rejected by `assertValidSearchRequest` with a message naming
the replacement, because the API either ignores them silently or 400s.

| Parameter | Replacement |
|-----------|-------------|
| `useAutoprompt` | Remove entirely — deprecated, does nothing |
| `includeUrls` / `excludeUrls` | `includeDomains` / `excludeDomains` |
| `numSentences` | `contents.highlights: true` |
| `highlightsPerUrl` | `contents.highlights: true` |
| `tokensNum` | `contents.text.maxCharacters` |
| `livecrawl: "always"` | `contents.maxAgeHours: 0` |
| top-level `text` / `summary` / `highlights` on `/search` | nest under `contents` |

---

## Where the setup guide diverges from the canonical docs

Checked on 2026-07-29. Nothing below is a contradiction that breaks the guide's
examples — the two patterns it recommends are correct — but these are worth
knowing. **The client follows the canonical docs wherever they differ.**

1. **`text.maxCharacters: 20000` exceeds the documented maximum.** The guide
   uses `20000` in both the `/search` and `/contents` content tables; the docs
   document the range as **1–10000**. The examples here use 8000.

2. **`text.verbosity` has three values, not two.** The guide lists
   `"compact" | "full"`. The docs also document `standard`. The client's
   `TextVerbosity` type includes all three.

3. **The `/contents` table uses snake_case in raw JSON.** The guide shows
   `"text": {"max_characters": 20000}` for `/contents` while using
   `maxCharacters` for `/search`. Raw JSON is camelCase for both endpoints —
   snake_case is Python-SDK-only. The client raises an explicit error on
   `max_characters` rather than letting it be silently dropped.

4. **`highlights` accepts an object, not just `true`.** The guide's tuning-knob
   list says only "pass `true`"; the docs document `{ query, maxCharacters }`,
   which lets you bias highlights toward a different question than the main
   query.

5. **`/contents` accepts `ids` as well as `urls`.** The guide only shows `urls`.

6. **`/answer` supports `outputSchema` and `stream`.** The guide describes it as
   prose-with-citations only.

7. **Parameters the guide omits entirely:** `category`, `userLocation`,
   `moderation`, `startPublishedDate` / `endPublishedDate`, `compliance`,
   `contents.livecrawlTimeout`, `contents.subpages`, `contents.subpageTarget`,
   `contents.extras`, and `text.includeSections` / `excludeSections`. The guide
   does mention the `company`/`people` + `excludeDomains` 400 under
   Troubleshooting without documenting `category` itself.

8. **Undocumented numeric limits.** The guide states no bounds for `numResults`
   (1–100, default 10), `includeDomains`/`excludeDomains` (max 1200, wildcards
   supported), `maxAgeHours` (-1–720), `livecrawlTimeout` (0–90000 ms), or
   `subpages` (0–100).

9. **Canonical URL redirects.** `docs.exa.ai/reference/...` 307s to
   `exa.ai/docs/reference/...`.
