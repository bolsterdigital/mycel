// The archive of one export (TODO #28): session, current membership with `tenant:admin` and a
// signed link from the export page, all required (lib/server/export-download.ts). Admin host
// only, like everything under /admin (hooks.server.ts, ADR 014 rule 4).
import { currentContext } from '@mycel/observability';
import { adminMediaPrincipal } from '#lib/server/admin.js';
import { serveExportDownload } from '#lib/server/export-download.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) =>
  serveExportDownload(
    runtime(),
    await adminMediaPrincipal(locals, params.tenant),
    params.tenant,
    params.id,
    url,
    currentContext().requestId ?? null
  );
