// The media library of a site in the admin (TODO #10b, brief #10 decision 10): upload and list
// here, each asset's details, edit and delete on its own page (`media/[id]`, brief #56 § C1), all
// through the same use cases HTTP and MCP expose, with native form posts and no JavaScript. The
// upload is a multipart form; the action reads the file and hands it to `media.upload` as base64,
// the one contract of that use case (brief decision 6). Rejected: a multipart variant of the use
// case for the admin only, a second contract for one operation.
//
// The list shows each asset's thumbnail from the admin's own route (`media/[id]/thumb`): the
// admin is on the platform origin, the site's `/media/...` route on the tenant's hostnames. The
// view (grid or list) is a query parameter, so it survives paging and works without a script.
import { MAX_UPLOAD_BYTES, can, useCases } from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { act, text } from '#lib/server/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  const rt = runtime();
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const [list, usage] = await Promise.all([
    rt.invoker.run(useCases.listMedia, principal, { cursor, limit: 50 }),
    can(principal, 'tenant:admin') ? rt.invoker.run(useCases.getUsage, principal, {}) : null,
  ]);
  return {
    items: list.items.map((m) => ({
      ...m,
      thumb: m.variants.some((v) => v.name === 'thumb'),
    })),
    view: url.searchParams.get('view') === 'list' ? ('list' as const) : ('grid' as const),
    nextCursor: list.nextCursor,
    deleted: url.searchParams.get('done') === 'deleted',
    storage: usage?.storage ?? null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
};

/** Core's i18n key of a refused upload, mapped to the admin's copy. */
const UPLOAD_ISSUES: Record<string, UiKey> = {
  'media.type.svg': 'admin.media.error.svg',
  'media.type.unsupported': 'admin.media.error.type',
  'media.type.mismatch': 'admin.media.error.mismatch',
  'media.type.unreadable': 'admin.media.error.unreadable',
  'media.pixels.too_many': 'admin.media.error.pixels',
  'media.size.too_large': 'admin.media.error.tooLarge',
  'media.bytes.empty': 'admin.media.error.noFile',
  'media.filename.empty': 'admin.media.error.noFile',
  'media.filename.too_long': 'admin.media.error.filename',
  'media.filename.invalid': 'admin.media.error.filename',
};

export const actions: Actions = {
  upload: (event) =>
    act(
      event,
      'upload',
      {
        conflict: 'admin.error.invalid',
        invalid: 'admin.media.error.invalid',
        issues: UPLOAD_ISSUES,
      },
      async (principal, data) => {
        const file = data.get('file');
        if (!(file instanceof File) || file.size === 0)
          return fail(400, { action: 'upload', error: 'admin.media.error.noFile' as UiKey });
        if (file.size > MAX_UPLOAD_BYTES)
          return fail(400, { action: 'upload', error: 'admin.media.error.tooLarge' as UiKey });
        const m = await runtime().invoker.run(useCases.uploadMedia, principal, {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
          access: text(data, 'access') === 'restricted' ? 'restricted' : 'public',
        });
        return {
          action: 'upload',
          done: 'admin.media.done.uploaded' as UiKey,
          filename: m.filename,
          id: m.id,
        };
      }
    ),
};
