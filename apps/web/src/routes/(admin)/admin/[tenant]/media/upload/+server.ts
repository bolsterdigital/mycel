// The media picker's upload (brief media-picker): one file per request, so the script can show
// progress per file, answered as JSON with the new image as a choice or the refusal in the
// operator's words. The same `uploadFile` as the media page's action; `body-limit.ts` gives this
// route the same ceiling. Rejected: posting to `media?/upload` from the script, whose answer is
// SvelteKit's serialised action result, not a contract a plain script should parse.
import { json } from '@sveltejs/kit';
import { MAX_UPLOAD_BYTES } from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { uploadFile } from '#lib/server/media-choices.js';
import { formatBytes } from '#lib/admin/format.js';
import { fill, ui } from '../../../../../../i18n/index.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, params, request }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const locale = locals.lang ?? 'en';
  const t = ui(locale);
  const file = (await request.formData()).get('file');
  if (!(file instanceof File))
    return json({ error: t('admin.media.error.noFile') }, { status: 400 });
  const r = await uploadFile(principal, file, 'public');
  if (r.ok) return json(r.choice, { status: 201 });
  return json(
    {
      error: fill(t(r.error), {
        what: r.what ? t(r.what) : '',
        filename: r.filename,
        max: formatBytes(MAX_UPLOAD_BYTES, locale),
      }),
    },
    { status: r.status }
  );
};
