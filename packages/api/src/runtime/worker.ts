// Standalone worker: drains committed outbox events into the in-process subscribers (supporter
// ingest, confirmation mail) and runs due jobs (TODO #15). Several can run side by side thanks
// to SKIP LOCKED.
//
// With PORT set (as in the container image) it also answers GET /healthz, /readyz and /metrics
// (health.ts), so every entrypoint of the image shares one healthcheck. Without PORT (local
// `npm run worker`) it opens no port and cannot collide with the API on 8787.

import { createRuntime } from './compose.js';
import { startWorkerHealth } from '../health.js';

const runtime = createRuntime(undefined, { service: 'worker' });
runtime.startWorker();
runtime.log.info('worker running: outbox and jobs');

const port = process.env['PORT'];
const health = port
  ? startWorkerHealth(
      Number(port),
      { readiness: () => runtime.workerReadiness(), metrics: runtime.metrics },
      () => runtime.log.info('worker health listening', { port: Number(port) })
    )
  : null;

const shutdown = () => {
  health?.close();
  void runtime.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
