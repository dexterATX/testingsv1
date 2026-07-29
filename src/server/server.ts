/**
 * Local web server for running research from a browser.
 *
 * The pipeline runs server-side and streams progress to the page over SSE, so
 * Exa's raw hits appear immediately and the ranked, deduped, synthesized
 * result fills in behind them.
 *
 * **API keys never leave this process.** The browser talks only to localhost
 * and receives results, never credentials — which is also why the server binds
 * to 127.0.0.1 by default rather than 0.0.0.0.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ExaClient } from '../exa/client.js';
import { VoxellClient } from '../voxell/client.js';
import { FileVectorStore } from '../store/file.js';
import { researchSearch, type ResearchReport } from '../research/pipeline.js';
import type { ResearchEvent } from '../research/events.js';
import { synthesize } from '../synthesis/synthesize.js';
import { anthropicCompleter } from '../synthesis/anthropic.js';
import { fireworksCompleter } from '../synthesis/fireworks.js';
import type { Completer } from '../synthesis/types.js';

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
  provider?: unknown;
  searchType?: unknown;
}

interface RunConfig {
  query: string;
  numResults: number;
  chunk: boolean;
  cluster: boolean;
  topK: number | undefined;
  synthesize: boolean;
  provider: 'anthropic' | 'fireworks' | undefined;
  searchType: string | undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024;

/** Which synthesis providers this process actually has keys for. */
export function availableProviders(): Array<'anthropic' | 'fireworks'> {
  const providers: Array<'anthropic' | 'fireworks'> = [];
  if (process.env['ANTHROPIC_API_KEY']) providers.push('anthropic');
  if (process.env['FIREWORKS_API_KEY']) providers.push('fireworks');
  return providers;
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
    raw.provider === 'anthropic' || raw.provider === 'fireworks' ? raw.provider : undefined;

  return {
    query,
    numResults,
    chunk: raw.chunk === true,
    cluster: raw.cluster !== false,
    topK,
    synthesize: raw.synthesize === true,
    provider,
    searchType: typeof raw.searchType === 'string' ? raw.searchType : undefined,
  };
}

function pickCompleter(provider: RunConfig['provider']): { name: string; completer: Completer } {
  const available = availableProviders();
  const chosen = provider ?? available[0];

  if (!chosen) {
    throw new Error(
      'No synthesis provider configured. Set ANTHROPIC_API_KEY or FIREWORKS_API_KEY.',
    );
  }
  if (!available.includes(chosen)) {
    throw new Error(`No API key for "${chosen}". Available: ${available.join(', ') || 'none'}.`);
  }

  return chosen === 'anthropic'
    ? { name: 'anthropic', completer: anthropicCompleter() }
    : { name: 'fireworks', completer: fireworksCompleter() };
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
      .end(JSON.stringify({ error: (error as Error).message }));
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

    const report = await researchSearch(exa, voxell, {
      query: config.query,
      numResults: config.numResults,
      chunk: config.chunk,
      cluster: config.cluster,
      ...(config.topK !== undefined ? { topK: config.topK } : {}),
      ...(config.searchType ? { search: { type: config.searchType as never } } : {}),
      onEvent: (event: ResearchEvent) => send(event),
      signal: controller.signal,
    });

    send({ type: 'report', report: serializeReport(report) });

    if (config.synthesize) {
      const { name, completer } = pickCompleter(config.provider);
      send({ type: 'synthesis:start', provider: name });

      const synthesis = await synthesize(report, {
        completer,
        maxSources: Math.min(report.results.length, 12),
        signal: controller.signal,
      });

      send({ type: 'synthesis:done', synthesis });
    }

    send({ type: 'complete' });
  } catch (error) {
    if (!controller.signal.aborted) {
      send({
        type: 'error',
        message: (error as Error).message,
        name: (error as Error).name,
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
 */
export function serializeReport(report: ResearchReport): Record<string, unknown> {
  return {
    query: report.query,
    stats: report.stats,
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
            providers: availableProviders(),
            hasExa: Boolean(process.env['EXA_API_KEY']),
            hasVoxell: Boolean(process.env['VOXELL_API_KEY']),
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
