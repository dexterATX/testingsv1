/**
 * Local web server for the research UI.
 *
 * @example
 * const { url } = await startServer({ webRoot: 'web' });
 * console.log(`open ${url}`);
 */

export { availableProviders, createServer, parseRunRequest, startServer } from './server.js';
export type { ServerOptions } from './server.js';
