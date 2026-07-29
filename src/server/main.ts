/**
 * Entry point for `npm run web`.
 *
 * Binds to localhost only — the API keys live in this process and the browser
 * never sees them.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { availableProviders, startServer } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled).
const packageRoot = resolve(here, '..', '..');
const webRoot = resolve(packageRoot, 'web');

/*
 * Anchor the cache to the package, not to the working directory.
 *
 * A relative `.cache/vectors.jsonl` silently follows whatever CWD the process
 * happens to start in — which is fine from `npm run web` and wrong everywhere
 * else: a systemd unit without `WorkingDirectory`, a cron entry, or a shell
 * that started the server from somewhere else all end up writing to a
 * different cache, or failing outright on a read-only directory.
 */
const cachePath = process.env['CACHE_PATH'] ?? resolve(packageRoot, '.cache', 'vectors.jsonl');

const port = Number(process.env['PORT'] ?? 4317);
const host = process.env['HOST'] ?? '127.0.0.1';
const { url } = await startServer({ port, host, webRoot, cachePath });

const providers = availableProviders();

console.log(`\n  Research Toolkit  →  ${url}\n`);
console.log(`  exa       ${process.env['EXA_API_KEY'] ? 'ready' : 'MISSING EXA_API_KEY'}`);
console.log(`  voxell    ${process.env['VOXELL_API_KEY'] ? 'ready' : 'MISSING VOXELL_API_KEY'}`);
console.log(`  synthesis ${providers.length > 0 ? providers.join(', ') : 'none configured'}`);
console.log(`  cache     ${cachePath}\n`);

if (host !== '127.0.0.1' && host !== 'localhost') {
  // The UI has no login and this process holds live API keys.
  console.log(`  WARNING: bound to ${host}, not localhost. Anyone who can reach`);
  console.log('           this port can spend your API credits. Put it behind a');
  console.log('           reverse proxy with a password.\n');
}

console.log('  Ctrl-C to stop.\n');
