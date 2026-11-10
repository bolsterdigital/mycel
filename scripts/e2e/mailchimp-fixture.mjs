// A loopback-only provider fixture exercises real HTTP in the complete browser flow. Rejected:
// live customer accounts or a browser test which replaces the durable feed with a direct call.
import { createServer } from 'node:http';
const members = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  let result = {},
    status = 200;
  const match = /^\/3\.0\/lists\/([a-zA-Z0-9]+)\/members\/([a-f0-9]{32})$/.exec(url.pathname);
  if (url.pathname === '/healthz') result = { ok: true };
  else if (url.pathname === '/3.0/')
    result = { account_id: 'synthetic-account', account_name: 'Synthetic Mailchimp' };
  else if (url.pathname === '/3.0/lists')
    result = { total_items: 1, lists: [{ id: 'synthetic', name: 'Synthetic newsletter' }] };
  else if (url.pathname === '/3.0/lists/synthetic/merge-fields')
    result = {
      total_items: 1,
      merge_fields: [{ tag: 'FNAME', name: 'First name', type: 'text', required: false }],
    };
  else if (url.pathname === '/3.0/lists/synthetic')
    result = { id: 'synthetic', name: 'Synthetic newsletter' };
  else if (match) {
    const key = `${match[1]}:${match[2]}`;
    const prior = members.get(key);
    if (request.method === 'GET') {
      result = prior ?? {};
      status = prior ? 200 : 404;
    } else if (request.method === 'PUT' || request.method === 'PATCH') {
      if (request.method === 'PATCH' && !prior) status = 404;
      else {
        result = {
          ...prior,
          id: match[2],
          email_address: body.email_address ?? prior?.email_address,
          status: body.status ?? prior?.status ?? body.status_if_new,
          merge_fields: body.merge_fields ?? prior?.merge_fields ?? {},
          last_changed: new Date().toISOString(),
          ...(body.timestamp_opt ? { timestamp_opt: body.timestamp_opt } : {}),
        };
        members.set(key, result);
      }
    }
  } else if (url.pathname.startsWith('/control/')) {
    const hash = url.pathname.split('/').pop();
    const key = `synthetic:${hash}`;
    result = { ...members.get(key), ...body, last_changed: new Date().toISOString() };
    members.set(key, result);
  } else status = 404;
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(result));
});
server.listen(Number(process.env.MAILCHIMP_FIXTURE_PORT), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
