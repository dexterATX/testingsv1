/**
 * Local web server for running research from a browser.
 *
 * The pipeline runs server-side and streams progress to the page over SSE, so
 * the raw search hits appear immediately and the ranked, deduped, synthesized
 * result fills in behind them.
 *
 * **API keys never leave this process.** The browser talks only to localhost
 * and receives results, never credentials — which is also why the server binds
 * to 127.0.0.1 by default rather than 0.0.0.0.
 *
 * **Provider names never leave this process either.** Every wire payload is
 * built field by field, so the page learns what each stage did and nothing
 * about which vendor did it. See `./redact.ts` for why that is enforced here
 * and not in the UI.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ExaClient } from '../exa/client.js';
import { SEARCH_TYPES, type SearchType } from '../exa/types.js';
import { VoxellClient } from '../voxell/client.js';
import { FileVectorStore } from '../store/file.js';
import { researchSearch, type ResearchReport } from '../research/pipeline.js';
import { expandQuery, normalizeQuery } from '../research/expand.js';
import type { ResearchEvent } from '../research/events.js';
import { synthesize, type Synthesis } from '../synthesis/synthesize.js';
import { anthropicCompleter } from '../synthesis/anthropic.js';
import { fireworksCompleter } from '../synthesis/fireworks.js';
import type { Completer } from '../synthesis/types.js';
import { redactErrorName, redactMessage } from './redact.js';

export interface ServerOptions {
  port?: number;
  /** Defaults to 127.0.0.1 — the keys live in this process. */
  host?: string;
  /** Directory holding the static UI. */
  webRoot: string;
  /** Path for the on-disk embedding cache, or `false` to stay in memory. */
  cachePath?: string | false;
}

/** Everything the page may send. Anything else is rejected. */
interface RunRequest {
  query?: unknown;
  numResults?: unknown;
  chunk?: unknown;
  cluster?: unknown;
  topK?: unknown;
  synthesize?: unknown;
  /** An opaque id from `/api/config`, never a provider name. */
  writer?: unknown;
  extraQueries?: unknown;
  expand?: unknown;
  searchType?: unknown;
}

type Provider = 'anthropic' | 'fireworks';

interface RunConfig {
  query: string;
  numResults: number;
  chunk: boolean;
  cluster: boolean;
  topK: number | undefined;
  synthesize: boolean;
  provider: Provider | undefined;
  searchType: SearchType | undefined;
  extraQueries: string[];
  expand: boolean;
}

/** Writer id shown to the page, per provider. */
export interface Writer {
  id: string;
  label: string;
}

/**
 * Stable, opaque ids for the write-up backends.
 *
 * Deliberately not derived from position: the page caches these across runs,
 * and a positional id would silently start meaning a different backend the
 * moment a key is added or removed.
 */
const WRITER_ID: Record<Provider, string> = {
  anthropic: 'writer-a',
  fireworks: 'writer-b',
};

const PROVIDER_BY_WRITER_ID = new Map<string, Provider>(
  (Object.entries(WRITER_ID) as Array<[Provider, string]>).map(([provider, id]) => [id, provider]),
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Extra searches per run, typed and generated together.
 *
 * Every one is another paid search whose results all have to be embedded, so
 * this is a spend ceiling rather than a validation rule.
 */
const MAX_EXTRA_SEARCHES = 8;

/**
 * Which synthesis providers this process actually has keys for.
 *
 * Server-side only — the page gets `availableWriters()` instead.
 */
export function availableProviders(): Provider[] {
  const providers: Provider[] = [];
  if (process.env['ANTHROPIC_API_KEY']) providers.push('anthropic');
  if (process.env['FIREWORKS_API_KEY']) providers.push('fireworks');
  return providers;
}

/**
 * The same list, as opaque ids the page can offer as a choice.
 *
 * The first configured provider is the default, so the labels describe rank
 * rather than identity.
 */
export function availableWriters(): Writer[] {
  const providers = availableProviders();

  return providers.map((provider, index) => ({
    id: WRITER_ID[provider],
    label:
      index === 0 ? 'Default' : providers.length > 2 ? `Alternate ${index}` : 'Alternate',
  }));
}

export function parseRunRequest(raw: RunRequest): RunConfig {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (query === '') throw new Error('`query` is required.');
  if (query.length > 2000) throw new Error('`query` is too long (max 2000 characters).');

  const numResults =
    typeof raw.numResults === 'number' && Number.isInteger(raw.numResults)
      ? Math.min(Math.max(raw.numResults, 1), 100)
      : 25;

  const topK =
    typeof raw.topK === 'number' && Number.isInteger(raw.topK) && raw.topK > 0
      ? raw.topK
      : undefined;

  const provider =
    typeof raw.writer === 'string' ? PROVIDER_BY_WRITER_ID.get(raw.writer) : undefined;

  /*
   * Each extra query is another Exa search merged into the same run. Capped
   * because every one costs a search and the results all have to be embedded;
   * eight is already 8x the spend of a plain run.
   */
  const extraQueries = (Array.isArray(raw.extraQueries) ? raw.extraQueries : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== query)
    .slice(0, MAX_EXTRA_SEARCHES);

  /*
   * Checked here, at the boundary, rather than cast through. An unknown value
   * used to reach the search client and fail there, with a message about a
   * request body — several layers from the dropdown that sent it.
   */
  let searchType: SearchType | undefined;
  if (typeof raw.searchType === 'string' && raw.searchType !== '') {
    if (!(SEARCH_TYPES as readonly string[]).includes(raw.searchType)) {
      throw new Error(`Unknown search type. Expected one of: ${SEARCH_TYPES.join(', ')}.`);
    }
    searchType = raw.searchType as SearchType;
  }

  return {
    query,
    numResults,
    chunk: raw.chunk === true,
    cluster: raw.cluster !== false,
    topK,
    synthesize: raw.synthesize === true,
    provider,
    searchType,
    extraQueries,
    expand: raw.expand === true,
  };
}

/**
 * Merges the searches the user typed with the ones the model wrote.
 *
 * Typed queries come first and survive the cap: they are what the user
 * actually asked for, and `expandQuery` only knows to avoid repeating the
 * *original question* — it has never seen the *Also search for* box, so a
 * generated line can collide with one typed there. Paying twice for the same
 * hits is exactly what the cap exists to stop.
 */
export function mergeSearches(typed: string[], generated: string[]): string[] {
  const seen = new Set(typed.map(normalizeQuery));
  const merged = [...typed];

  for (const query of generated) {
    const key = normalizeQuery(query);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(query);
  }

  return merged.slice(0, MAX_EXTRA_SEARCHES);
}

/**
 * Resolves the write-up backend.
 *
 * The failure messages stay generic on purpose: they are shown in the browser,
 * and naming the missing key would name the vendor. The README says which
 * variables `.env` wants.
 */
function pickCompleter(provider: RunConfig['provider']): Completer {
  const available = availableProviders();
  const chosen = provider ?? available[0];

  if (!chosen) {
    throw new Error('No write-up backend is configured. Add an API key to .env — see the README.');
  }
  if (!available.includes(chosen)) {
    throw new Error('That write-up backend has no API key configured.');
  }

  return chosen === 'anthropic' ? anthropicCompleter() : fireworksCompleter();
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** Serves the UI, refusing any path that escapes the web root. */
async function serveStatic(
  webRoot: string,
  urlPath: string,
  response: http.ServerResponse,
): Promise<void> {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = resolve(join(webRoot, normalize(relative)));

  if (!target.startsWith(resolve(webRoot))) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');

    response.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    await pipeline(createReadStream(target), response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

/**
 * Strips the name-bearing fields off a pipeline event.
 *
 * `embed:done` is the only event that carries one today, and it is rebuilt
 * field by field rather than spread-minus-`model`, so a name added to the
 * event later is excluded by default instead of leaking on the next release.
 */
function publicEvent(event: ResearchEvent): Record<string, unknown> {
  if (event.type !== 'embed:done') return event;

  return {
    type: event.type,
    dim: event.dim,
    tokens: event.tokens,
    cacheHits: event.cacheHits,
    latencyMs: event.latencyMs,
  };
}

/** Same treatment for the write-up: everything except which model wrote it. */
function publicSynthesis(synthesis: Synthesis): Record<string, unknown> {
  return {
    query: synthesis.query,
    text: synthesis.text,
    sources: synthesis.sources,
    invalidMarkers: synthesis.invalidMarkers,
    uncitedMarkers: synthesis.uncitedMarkers,
    stopReason: synthesis.stopReason,
    usage: synthesis.usage,
  };
}

/** Runs the pipeline, streaming each stage to the page as an SSE frame. */
async function handleRun(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ServerOptions,
): Promise<void> {
  let config: RunConfig;
  try {
    config = parseRunRequest(JSON.parse(await readBody(request)) as RunRequest);
  } catch (error) {
    response
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: redactMessage((error as Error).message) }));
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: Record<string, unknown>): void => {
    if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // A closed tab should stop the work, not leave it running.
  const controller = new AbortController();
  request.on('close', () => controller.abort());

  try {
    const exa = new ExaClient();
    const voxell = new VoxellClient(
      options.cachePath === false
        ? {}
        : { store: new FileVectorStore({ path: options.cachePath ?? '.cache/vectors.jsonl' }) },
    );

    /*
     * Expansion runs here rather than inside the pipeline, so that
     * `researchSearch` keeps taking only a search client and an embeddings
     * client. A caller without a write-up key can still search, and the
     * offline suite stays hermetic.
     */
    let expanded: string[] = [];
    if (config.expand && availableProviders().length > 0) {
      expanded = await expandQuery(config.query, {
        completer: pickCompleter(config.provider),
        count: 3,
        signal: controller.signal,
        // Full detail to the terminal, where the operator is; the page gets an
        // empty list, which is all it needs to say the run stayed narrow.
        onError: (error) => console.error('[research] expansion skipped:', error),
      });

      // Sent even when empty. Otherwise a transient failure looks exactly like
      // a checkbox that does nothing.
      send({ type: 'expand:done', queries: expanded });
    }

    const allExtras = mergeSearches(config.extraQueries, expanded);

    const report = await researchSearch(exa, voxell, {
      query: config.query,
      numResults: config.numResults,
      chunk: config.chunk,
      cluster: config.cluster,
      ...(config.topK !== undefined ? { topK: config.topK } : {}),
      ...(allExtras.length > 0
        ? { extraSearches: allExtras.map((extra) => ({ query: extra })) }
        : {}),
      ...(config.searchType ? { search: { type: config.searchType } } : {}),
      onEvent: (event: ResearchEvent) => send(publicEvent(event)),
      signal: controller.signal,
    });

    send({ type: 'report', report: serializeReport(report) });

    if (config.synthesize) {
      const completer = pickCompleter(config.provider);
      send({ type: 'synthesis:start' });

      const synthesis = await synthesize(report, {
        completer,
        maxSources: Math.min(report.results.length, 12),
        signal: controller.signal,
      });

      send({ type: 'synthesis:done', synthesis: publicSynthesis(synthesis) });
    }

    send({ type: 'complete' });
  } catch (error) {
    if (!controller.signal.aborted) {
      // The operator gets the real error; the page gets it with the vendor
      // filed off, since an upstream message can quote a model id or a host.
      console.error('[research] run failed:', error);

      send({
        type: 'error',
        message: redactMessage((error as Error).message),
        name: redactErrorName((error as Error).name),
      });
    }
  } finally {
    if (!response.writableEnded) response.end();
  }
}

/**
 * Trims the report for the wire.
 *
 * With chunking on, `embeddedText` holds whole pages — sending those would
 * dwarf everything else on the stream for no benefit, since the page only ever
 * renders the best-matching excerpt.
 *
 * `stats.model` is dropped for a different reason: it names the embedding
 * backend, and the page is vendor-neutral.
 */
export function serializeReport(report: ResearchReport): Record<string, unknown> {
  const stats = report.stats;

  return {
    query: report.query,
    stats: {
      retrieved: stats.retrieved,
      exactDuplicates: stats.exactDuplicates,
      embedded: stats.embedded,
      chunks: stats.chunks,
      nearDuplicates: stats.nearDuplicates,
      demotedByDomain: stats.demotedByDomain,
      hydrated: stats.hydrated,
      hydrateFailed: stats.hydrateFailed,
      belowThreshold: stats.belowThreshold,
      dim: stats.dim,
      tokens: stats.tokens,
      embedLatencyMs: stats.embedLatencyMs,
      cacheHits: stats.cacheHits,
    },
    clusters: report.clusters ?? null,
    results: report.results.map((entry) => ({
      url: entry.result.url,
      title: entry.result.title ?? null,
      publishedDate: entry.result.publishedDate ?? null,
      author: entry.result.author ?? null,
      highlights: entry.result.highlights?.slice(0, 2) ?? [],
      score: entry.score,
      originalRank: entry.originalRank,
      rankDelta: entry.rankDelta,
      chunkCount: entry.chunkCount ?? null,
      bestChunk: entry.bestChunk
        ? { text: entry.bestChunk.text.slice(0, 600), score: entry.bestChunk.score }
        : null,
      duplicates: entry.duplicates.map((duplicate) => ({
        url: duplicate.result.url,
        title: duplicate.result.title ?? null,
        similarity: duplicate.similarity,
      })),
    })),
  };
}

export function createServer(options: ServerOptions): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/config' && request.method === 'GET') {
      response
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(
          JSON.stringify({
            // Capabilities, not vendors: the page needs to know what it can
            // offer, not who is behind it.
            search: Boolean(process.env['EXA_API_KEY']),
            embeddings: Boolean(process.env['VOXELL_API_KEY']),
            writers: availableWriters(),
          }),
        );
      return;
    }

    if (url.pathname === '/api/run' && request.method === 'POST') {
      void handleRun(request, response, options);
      return;
    }

    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET, POST' }).end('Method not allowed');
      return;
    }

    void serveStatic(options.webRoot, url.pathname, response);
  });
}

/** Starts the server and resolves with the bound port. */
export async function startServer(options: ServerOptions): Promise<{
  server: http.Server;
  port: number;
  url: string;
}> {
  const server = createServer(options);
  const host = options.host ?? '127.0.0.1';

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolvePromise);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return { server, port, url: `http://${host}:${port}` };
}
