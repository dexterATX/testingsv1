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
const webRoot = resolve(here, '..', '..', 'web');

const port = Number(process.env['PORT'] ?? 4317);
const { url } = await startServer({ port, webRoot });

const providers = availableProviders();

console.log(`\n  Research Toolkit  →  ${url}\n`);
console.log(`  exa       ${process.env['EXA_API_KEY'] ? 'ready' : 'MISSING EXA_API_KEY'}`);
console.log(`  voxell    ${process.env['VOXELL_API_KEY'] ? 'ready' : 'MISSING VOXELL_API_KEY'}`);
console.log(`  synthesis ${providers.length > 0 ? providers.join(', ') : 'none configured'}\n`);
console.log('  Ctrl-C to stop.\n');
