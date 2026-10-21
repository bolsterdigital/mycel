// Standalone outbox worker: drains committed events into the in-process subscribers (supporter
// ingest, confirmation mail). Several can run side by side thanks to SKIP LOCKED.
//
// With PORT set (as in the container image) it also answers GET /healthz, so every entrypoint
// of the image shares one healthcheck. Rejected: a heartbeat file checked by a separate command,
// which would give the worker a healthcheck of its own. Without PORT (local `npm run worker`)
// it opens no port and cannot collide with the API on 8787.

import { createServer } from 'node:http';
import { createRuntime } from './compose.js';

const runtime = createRuntime();
runtime.startWorker();
console.log('outbox worker running');

const port = process.env['PORT'];
const health = port
  ? createServer((req, res) => {
      const ok = req.method === 'GET' && req.url === '/healthz';
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    }).listen(Number(port), () => console.log(`worker health on :${port}/healthz`))
  : null;

const shutdown = () => {
  health?.close();
  void runtime.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
