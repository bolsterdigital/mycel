// A variant in the media admin's detail page (brief #56 § C1): the preview and the lightbox show
// a resized variant, never the original, from the admin itself for the same reason as the
// thumbnail (the admin is on the platform origin). Same rules as the thumbnail: the operator's
// session with `media:read`, private, five minutes. Rejected: a signed link to the site's route,
// which is on a tenant hostname and would put the admin's preview behind the site's cache.
import { runtime } from '#lib/server/runtime.js';
import { adminMediaPrincipal } from '#lib/server/admin/admin.js';
import { serveAdminMedia } from '#lib/server/media.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) =>
  serveAdminMedia(
    runtime(),
    await adminMediaPrincipal(locals, params.tenant),
    params.id,
    params.file,
    url
  );
