// Docker HEALTHCHECK for every entrypoint (api, web, worker): GET /healthz on $PORT.
// Node's built-in fetch, because the slim base image has neither curl nor wget.
// Rejected: installing curl into the runtime image for one request.
const port = process.env.PORT ?? '3000';
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(2500),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
