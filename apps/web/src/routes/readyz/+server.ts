// Readiness (TODO #17a): `select 1` over the web app's own database connection within a second.
// `/healthz` stays the container's liveness probe and never touches the database, so a slow
// database takes the process out of rotation without restarting it.
import { json } from '@sveltejs/kit';
import { runtime } from '#lib/server/runtime.js';

export const GET = async () =>
  (await runtime().ready()) ? json({ db: 'ok' }) : json({ db: 'down' }, { status: 503 });
