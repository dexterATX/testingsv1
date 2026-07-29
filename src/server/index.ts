/**
 * Local web server for the research UI.
 *
 * @example
 * const { url } = await startServer({ webRoot: 'web' });
 * console.log(`open ${url}`);
 */

export {
  availableProviders,
  availableWriters,
  createServer,
  parseRunRequest,
  startServer,
} from './server.js';
export type { ServerOptions, Writer } from './server.js';
export { namesAProvider, redactErrorName, redactMessage } from './redact.js';
