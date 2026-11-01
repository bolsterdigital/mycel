// See lib/server/http/reports.ts. The body limit is in lib/server/http/body-limit.ts, and the route
// is reached on every hostname because hooks.server.ts lets it through before site resolution.
import type { RequestHandler } from './$types';
import { reportBudget, reportLines } from '#lib/server/http/reports.js';
import { runtime } from '#lib/server/runtime.js';

const budget = reportBudget();

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/reports+json')
    return new Response(null, { status: 415 });
  let batch: unknown;
  try {
    batch = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 400 });
  }
  const lines = reportLines(batch);
  if (!lines) return new Response(null, { status: 400 });
  const rt = runtime();
  for (const line of lines) {
    const { allowed, dropped } = budget.take(rt.clock.now().getTime());
    if (dropped > 0) rt.log.warn('browser reports dropped', { dropped });
    if (allowed) rt.log.warn('browser report', line);
  }
  return new Response(null, { status: 204 });
};
