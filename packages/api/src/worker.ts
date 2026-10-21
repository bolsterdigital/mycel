// Standalone outbox worker: drains committed events into the in-process subscribers (supporter
// ingest, confirmation mail). Several can run side by side thanks to SKIP LOCKED.

import { createRuntime } from './compose.js';

const runtime = createRuntime();
runtime.startWorker();
console.log('outbox worker running');
const shutdown = () => void runtime.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
