// "Download original" in the media admin (TODO #10b): the operator's session and a signed path
// from the media page, both required (lib/server/media.ts has the table). Without a session this
// is a 403, not a redirect to the login: a download link is not a page to come back to.
import { runtime } from '#lib/server/runtime.js';
import { adminMediaPrincipal } from '#lib/server/admin.js';
import { serveAdminMedia } from '#lib/server/media.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) =>
  serveAdminMedia(
    runtime(),
    await adminMediaPrincipal(locals, params.tenant),
    params.id,
    'original',
    url
  );
