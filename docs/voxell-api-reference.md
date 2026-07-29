# Voxell API reference

Voxell publishes no public reference documentation — `docs.voxell.ai` does not
resolve. **Everything below was measured against the live API on 2026-07-29**
by probing `api.voxell.ai` directly, and is encoded in `src/voxell/`.

Because this is measured rather than documented, it can drift without notice.
`test/live/voxell.live.test.ts` re-checks every claim here:

```bash
VOXELL_LIVE_TEST=1 npm run test:live
```

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

## Endpoints that do not exist

Probed and returning 404: `/v1/rerank`, `/health`, `/v1`.

The absence of `/v1/rerank` is why `src/research/` reranks locally with cosine
similarity rather than delegating it.

---

## Not established

Honest gaps — these were not measured, so the client makes no claims about them:

- **Rate limits.** No `x-ratelimit-*` headers are returned, and no 429 was
  triggered during probing. The client retries 429s with `Retry-After`
  handling on the assumption that limits exist.
- **Pricing.** No cost field in any response.
- **Maximum batch size.** 512 works; the ceiling was not searched for.
- **Whether the 32,000-character limit counts UTF-16 units or UTF-8 bytes.**
  The client uses `String.length`, which is conservative for non-ASCII text.
