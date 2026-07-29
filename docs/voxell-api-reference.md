# Voxell API reference

**Voxell now publishes docs at [voxell.ai/docs](https://voxell.ai/docs/)** —
`docs.voxell.ai` still does not resolve, which is what made an earlier revision
of this file conclude there were none. Re-checked 2026-07-29.

Two kinds of claim below, kept apart on purpose:

- **Measured** — probed against `api.voxell.ai` directly. Most of this file.
  `test/live/voxell.live.test.ts` re-checks every measured claim:
  `VOXELL_LIVE_TEST=1 npm run test:live`
- **Documented** — from voxell.ai. Marked *(documented)*. Not independently
  verified unless a measured note says otherwise.

Where the two disagree, the measurement wins and the disagreement is recorded.

---

## What Voxell is

A GPU-native retrieval stack, not just an embeddings endpoint. Four products
share `api.voxell.ai`; this toolkit uses only the first.

| Product | What it is | Used here |
|---|---|---|
| **Forge** | The embedding API — `/v1/embed`, three tiers | **yes** |
| **Answers** | Managed RAG: upload documents, get cited answers. Chunking, embedding, HNSW + BM25 hybrid retrieval, and answer generation (Gemini) behind two calls | no |
| **Spaces** | Hosted question-answering portals over an uploaded corpus | no |
| **Lux** | Self-hosted real-time cross-device state sync. Unrelated to retrieval | no |

Positioning claims *(documented)*: rank #1 on English MTEB v2 at Borda 75.99,
independently checkable on the [public
leaderboard](https://huggingface.co/spaces/mteb/leaderboard); Turbo outscores
OpenAI's best embedding model; 87 ms P50 end-to-end on owned NVIDIA DGX
hardware against a stated 300 ms market average. The `x-forge-timing` header
does corroborate the latency figure — see *Response headers* below.

**Answers overlaps this toolkit, but does not replace it.** Answers reasons
over a corpus you upload. This tool researches the *live web* via Exa and never
has a fixed corpus, so the two are complementary rather than alternatives. If
the goal were ever "ask questions of our own documents", Answers would remove
most of `src/research/` and `src/synthesis/`.

---

## Pricing *(documented)*

| | |
|---|---|
| **Turbo** (1024d) | **Free forever**, no card. Rate-limited, not metered |
| **Pro** (2560d) | $0.30 / 1M tokens |
| **Ultra** (4096d) | $0.40 / 1M tokens |
| **Answers** | 50/month free, then $1.50 / 1,000 |
| Storage | 60,000 vectors free (~5,000 documents) — a ceiling, not a meter |
| Ingest | 100M tokens/month free |

Plans buy throughput, not features: Free 100 req/min, Precision ($20) 600,
Singularity ($200) 5,000, Enterprise ($500) 10,000. Every model is available on
the free tier, and production use on it is explicitly permitted.

Since this toolkit defaults to `turbo`, **embeddings cost nothing** — the
binding constraint is requests per minute, not spend.

---

## Authentication

```
Authorization: Bearer <VOXELL_API_KEY>
```

**The `Bearer` prefix is required.** A bare key — `Authorization: <key>` — is
rejected with `401 {"error":"missing or invalid Authorization header"}`, as is
`x-api-key`. This is the single most common integration mistake with this API,
because the snippet that circulates omits it:

```python
# WRONG — 401s
headers={"Authorization": "vf_sk_..."}

# RIGHT
headers={"Authorization": "Bearer vf_sk_..."}
```

---

## `POST /v1/embed`

```json
{ "texts": ["your text here"], "model": "turbo" }
```

| Field | Type | Notes |
|-------|------|-------|
| `texts` | string[] | **Required.** Non-empty. |
| `model` | string | Optional; defaults to `turbo`. |

### Response

```json
{
  "dim": 1024,
  "embeddings": [[-0.0189, ...]],
  "latency_ms": 12,
  "model": "qwen3-native-28l",
  "tokens": 4
}
```

`model` is the **backing model**, not the alias you sent — `turbo` comes back
as `qwen3-native-28l`. `tokens` is the total across every text in the request.

### Models

| Alias | Dimensions | Backing model | Latency (1 short text) |
|-------|-----------:|---------------|-----------------------:|
| `turbo` *(default)* | 1024 | qwen3-native-28l | ~12 ms |
| `pro` | 2560 | qwen3-native-36l | ~59 ms |
| `ultra-4k` | 4096 | qwen3-native-36l | ~98 ms |

The validation error names only these three:

```
400 {"error":"Invalid model specified. Allowed: turbo, pro, ultra-4k"}
```

…but the ids from `GET /v1/models` are **also accepted**, mapped onto the same
models. Note the OpenAI-named ones do *not* have OpenAI's dimensions:

| Alias | Dimensions | OpenAI's actual dimensions |
|-------|-----------:|---------------------------:|
| `forge-turbo` | 1024 | — |
| `forge-pro` | 2560 | — |
| `forge-ultra-4k` | 4096 | — |
| `text-embedding-3-small` | 2560 | 1536 ✗ |
| `text-embedding-3-large` | 4096 | 3072 ✗ |

Treat those two as compatibility shims for the endpoint shape only. Vectors
from different models are not comparable — changing models means re-embedding
the corpus.

### Limits

| Limit | Value | Over the limit |
|-------|-------|----------------|
| Characters per text | 32,000 | `413 {"error":"Single text exceeds maximum length of ~8192 tokens (max 32000 chars)"}` |
| Tokens per text | ~8,192 | same 413 |
| Texts per request | no ceiling found | 512 verified working in ~3.7 s |

The 32,000-character limit is per *individual text*, not per request. It is the
same for every model — `ultra-4k` refers to output dimensions, not a longer
input window.

### Vector properties

**L2-normalized.** Measured norm is `1.000000`, so cosine similarity is a plain
dot product. `src/research/similarity.ts` still normalizes defensively, which
costs nothing at these sizes and keeps the code correct for vectors from
elsewhere.

**Reproducible per request, but not bit-reproducible across batch shapes.**
An identical request returns a bit-identical vector. The *same text* in a
differently shaped batch can differ by up to ~6e-4 per component:

| Comparison | Bit-identical | Cosine |
|------------|---------------|-------:|
| Same request, repeated | yes | 1.000000 |
| Alone vs. in a batch of 2 | yes | 1.000000 |
| Alone vs. in a batch of 4 / 8 / 16 | **no** | 0.999989 |
| Alone vs. in a batch of 64 | **no** | 0.999995 |
| Same batch size, different filler *content* | yes | 1.000000 |
| Same batch size, different filler *length* | **no** | 0.999992 |

Filler content does not matter; batch size and text length do. That is the
signature of batched inference selecting kernels by padded tensor shape, so
reduction order changes.

Practical consequences:

- Ranking, dedupe, and clustering are unaffected — the drift is four orders of
  magnitude below any useful threshold.
- Caching is sound (`src/voxell/client.ts` caches by model + text).
- **Do not** key a hash, a content address, or an equality check on a vector,
  and do not expect byte-identical results when re-embedding a corpus in
  different batch sizes.

### Response headers

Measured 2026-07-29. An earlier revision of this file said there were no
rate-limit headers; there are, and they are exposed to browsers via
`access-control-expose-headers`.

| Header | Example | Notes |
|---|---|---|
| `x-ratelimit-limit` | `600` | Requests per minute for this key |
| `x-ratelimit-remaining` | `599` | Decrements per request |
| `x-ratelimit-reset` | `1785366035` | Epoch **seconds**, not a duration |
| `x-forge-timing` | `edge=0ms, grpc=59ms, engine=24ms, total=83ms` | Server-side breakdown; `total` corroborates the 87 ms claim |
| `x-request-id` | `16bbafc101084ebc` | The transport falls back to this when the body carries no id |
| `x-backend` | `spark2-grpc` | |

The key in `.env` reports **600/min**, which is the Precision tier rather than
the free tier's documented 100 — so either the account is on a paid plan or the
published free-tier figure is stale. Worth knowing before sizing a batch job;
`x-ratelimit-limit` is the authority, not the pricing page.

At this library's defaults (batch 128, concurrency 4) a 25-result research run
issues a handful of requests, so the ceiling is nowhere near binding. It would
matter when embedding a large corpus.

### Error shapes

| Case | Status | Body |
|------|--------|------|
| Empty `texts` array | 400 | `{"error":"texts must be a non-empty array"}` |
| `texts` not an array | 400 | `{"error":"texts must be a non-empty array"}` |
| Non-string entry | 400 | `{"error":"texts must be a non-empty array"}` |
| Unknown model | 400 | `{"error":"Invalid model specified. Allowed: ..."}` |
| Text over the limit | 413 | `{"error":"Single text exceeds maximum length ..."}` |
| Missing/bare auth header | 401 | `{"error":"missing or invalid Authorization header"}` |
| **Empty string in `texts`** | **502** | `error code: 502` |

That last row is a **server-side bug**: `{"texts": [""]}` returns a 502 rather
than a 400, which reads as an outage. `VoxellClient` rejects blank and
whitespace-only strings before sending, with a message naming the cause.

### Cloudflare fingerprinting

The API sits behind Cloudflare, which blocks some HTTP clients by TLS/UA
fingerprint:

```
403  error code: 1010
```

Python's `urllib` is blocked; `curl` and Node's `fetch` are not. A 1010 means
the *client* was rejected, not the key — `voxellErrorAdapter` says so in the
error message, because otherwise it looks exactly like an auth failure.

---

## `POST /v1/embeddings` (OpenAI-compatible)

```json
{ "input": ["alpha", "beta"], "model": "forge-turbo" }
```

```json
{
  "object": "list",
  "data": [{ "object": "embedding", "embedding": [...], "index": 0 }],
  "model": "forge-turbo",
  "usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
```

Useful for pointing an existing OpenAI-shaped SDK at Voxell. This client uses
`/v1/embed` instead, since the native shape returns `dim` and the backing model
without a second lookup.

---

## `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    { "id": "forge-turbo", "object": "model", "created": 1735689600, "owned_by": "voxell" },
    { "id": "forge-pro", "...": "..." },
    { "id": "forge-ultra-4k", "...": "..." },
    { "id": "text-embedding-3-small", "...": "..." },
    { "id": "text-embedding-3-large", "...": "..." }
  ]
}
```

---

## Answers — `POST /v1/wield/{corpus}/…`

Not used by this toolkit, recorded because the docs point at the wrong path.

```bash
# load a document; the corpus is created on first upload
curl https://api.voxell.ai/v1/wield/handbook/documents \
  -H "Authorization: Bearer $VOXELL_API_KEY" \
  -d '{"name":"policy.md","text":"..."}'

# ask
curl https://api.voxell.ai/v1/wield/handbook/query \
  -H "Authorization: Bearer $VOXELL_API_KEY" \
  -d '{"query":"How many vacation days?","mode":"answer"}'
```

```json
{ "corpus": "handbook", "mode": "answer", "query": "test",
  "answer": "No relevant context found in this corpus to answer the question.",
  "chunks": [] }
```

Querying an empty corpus returns that string rather than an invented answer,
which is the right failure mode for grounded retrieval.

**Documentation discrepancy.** The Forge page advertises
`POST /v1/answers` with `{"space": "...", "q": "..."}`. That path returns the
dashboard's **HTML**, not JSON, for any body — it is served by the web app, not
the API. `/v1/wield/{corpus}/query` is the working endpoint, and the shape is
`query`/`mode`, not `q`/`space`.

---

## Endpoints that do not exist

Probed and returning 404: `/v1/rerank`, `/health`, `/v1`, `/v1/spaces`.

The absence of `/v1/rerank` is why `src/research/` reranks locally with cosine
similarity rather than delegating it. Note that Answers *does* rank internally
(HNSW + BM25 hybrid, *documented*), but only over a corpus you have uploaded —
there is still no endpoint that reranks arbitrary passages against a query.

---

## Not established

Honest gaps — the client makes no claims about these:

- **Maximum batch size.** 512 works; the ceiling was not searched for.
- **Whether the 32,000-character limit counts UTF-16 units or UTF-8 bytes.**
  The client uses `String.length`, which is conservative for non-ASCII text.
- **Whether the rate-limit window is fixed or sliding.** `x-ratelimit-reset`
  advanced by roughly a second between calls rather than sitting at a minute
  boundary, which suggests sliding, but no burst test was run to confirm.
- **How `x-ratelimit-limit` relates to plan tier in general.** This key reports
  600 against a documented free-tier 100; one key is not a sample.
