/**
 * Keeps provider and model names out of everything the browser receives.
 *
 * The UI reports *what* the pipeline is doing, never *whose* API is doing it.
 * Two mechanisms enforce that, and they are not redundant:
 *
 * 1. **Structural** — the server builds the wire payloads field by field and
 *    simply never copies the name-bearing ones (`stats.model`,
 *    `embed:done.model`, `synthesis.model`, the chosen writer). Those are the
 *    only places a name is *guaranteed* to appear, so omitting them is a real
 *    guarantee rather than a filter. It also fails safe: a field added to the
 *    pipeline later is excluded until someone opts it in.
 * 2. **Textual** — error messages are free text and can quote an upstream
 *    response body, so they are scrubbed on the way out and logged verbatim on
 *    the way in. This half is best-effort: an upstream can name itself in a
 *    way the list below does not anticipate. That is precisely why errors are
 *    the *only* free text the stream carries.
 */

/**
 * Applied in order — an earlier entry may consume text a later one would
 * otherwise mangle (a URL, for instance, has the vendor name inside its host,
 * so it has to go before the bare-name rules).
 */
const SCRUB: Array<[RegExp, string]> = [
  // Defensive only. An upstream error should never echo a credential back,
  // but if one ever does it must not reach the page.
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|fw_[A-Za-z0-9]{8,}|vf_sk_[A-Za-z0-9]{8,})\b/g, '[redacted]'],

  // Env var names carry the vendor inside the identifier.
  [/\bEXA_API_KEY\b/g, 'the search API key'],
  [/\bVOXELL_API_KEY\b/g, 'the embedding API key'],
  [/\b(?:ANTHROPIC|FIREWORKS)_API_KEY\b/g, 'the write-up API key'],

  // "Missing Exa API key" ahead of the bare-name rules, which would otherwise
  // leave "Missing the search API API key".
  [/\bExa API key\b/gi, 'search API key'],
  [/\bVoxell API key\b/gi, 'embedding API key'],
  [/\b(?:ANTHROPIC|FIREWORKS) API key\b/gi, 'write-up API key'],

  // Any URL in an upstream error is an endpoint or a docs link, and its host
  // names the vendor. Replaced whole so the bare-name rules never see it.
  [/https?:\/\/[^\s"'<>)]+/gi, 'the upstream endpoint'],

  // Model identifiers.
  [/\baccounts\/[\w.-]+\/models\/[\w.-]+/gi, 'the configured model'],
  [/\b(?:claude|kimi|qwen)[\w.-]*/gi, 'the configured model'],

  // Bare vendor names, last.
  [/\bExa\b/gi, 'the search API'],
  [/\bVoxell\b/gi, 'the embedding API'],
  [/\b(?:Fireworks|Anthropic)\b/gi, 'the write-up API'],
];

/** Error-class prefixes, mapped to the pipeline stage the class belongs to. */
const NAME_PREFIX: Array<[RegExp, string]> = [
  [/^Exa/, 'Search'],
  [/^Voxell/, 'Embedding'],
  [/^(?:Fireworks|Anthropic)/, 'Writeup'],
];

/** Rewrites free text so it names no provider, model, or credential. */
export function redactMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Rewrites an error class name to name its stage instead of its vendor:
 * `ExaAuthError` becomes `SearchAuthError`, `VoxellTimeoutError` becomes
 * `EmbeddingTimeoutError`. The useful half of the name — what went wrong — is
 * kept, because it is what tells the user whether to retry or fix a key.
 */
export function redactErrorName(name: string): string {
  for (const [pattern, stage] of NAME_PREFIX) {
    if (pattern.test(name)) return name.replace(pattern, stage);
  }
  return name;
}

/**
 * True if `text` still names a provider or model.
 *
 * Exists for the tests: it is the assertion that proves a *server-authored*
 * payload — config, stats, an error frame — is clean, so it is deliberately
 * broader than `SCRUB`; it matches the names themselves, not the phrasings
 * `redactMessage` produces.
 *
 * Do not point it at retrieved content. A page titled "Anthropic releases…"
 * is the user's research, not a disclosure of what this tool runs on.
 */
export function namesAProvider(text: string): boolean {
  return /\b(?:exa|voxell|fireworks|anthropic|claude|kimi|qwen\w*)\b/i.test(text);
}
