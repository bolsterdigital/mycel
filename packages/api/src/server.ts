// HTTP server process: the API plus, by default, the outbox worker in the same process (set
// MYCEL_WORKER=off to run `npm run worker -w @mycel/api` separately).

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createRuntime } from './compose.js';

const runtime = createRuntime(undefined, { service: 'api' });
const app = createApp({
  invoker: runtime.invoker,
  authenticate: (h) => runtime.authenticateApiKey(h),
  platform: runtime.platformApi,
  observability: runtime.http,
  trustProxy: runtime.config.MYCEL_TRUST_PROXY === '1',
});
const port = Number(process.env['PORT'] ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => runtime.log.info('api listening', { port }));
if (process.env['MYCEL_WORKER'] !== 'off') runtime.startWorker();

const shutdown = () => {
  server.close();
  void runtime.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
