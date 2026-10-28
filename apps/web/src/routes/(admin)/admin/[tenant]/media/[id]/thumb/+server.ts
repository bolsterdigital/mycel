// The thumbnail in the media admin's list (TODO #10b), from the admin itself: the admin runs on
// the platform origin and the site's `/media/...` route belongs to the tenant's hostnames. The
// operator's session is enough; a thumbnail is no original.
import { runtime } from '#lib/server/runtime.js';
import { adminMediaPrincipal } from '#lib/server/admin.js';
import { serveAdminMedia } from '#lib/server/media.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) =>
  serveAdminMedia(
    runtime(),
    await adminMediaPrincipal(locals, params.tenant),
    params.id,
    'thumb.webp',
    url
  );
