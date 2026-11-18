// A loopback Plausible for the e2e run: the worker's real transport posts accepted signups here,
// and a spec reads back what arrived, headers included, to prove the outbound request end to end.
// A site identifier that starts with `down-` gets the 503 a proxy without Plausible answers, so a
// spec can watch the bounded retry while the form itself stays accepted.
// Rejected: the platform's own Plausible (a test would count on a real installation) and
// intercepting in the browser (the server event never passes through it).
import { createServer } from 'node:http';

const received = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let status = 200;
  let body = '';
  if (url.pathname === '/healthz') body = 'ok';
  else if (url.pathname === '/api/event' && request.method === 'POST') {
    const event = JSON.parse(Buffer.concat(chunks).toString() || 'null');
    received.push({ event, headers: request.headers });
    status = String(event?.domain).startsWith('down-') ? 503 : 202;
    body = status === 202 ? 'ok' : '';
  } else if (url.pathname === '/control/events') {
    const domain = url.searchParams.get('domain');
    body = JSON.stringify(received.filter((r) => r.event?.domain === domain));
  } else status = 404;
  // Closed after each answer, like the Mailchimp fixture (a pooled socket raced the idle close).
  response.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(body);
});
server.listen(Number(process.env.PLAUSIBLE_FIXTURE_PORT), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
