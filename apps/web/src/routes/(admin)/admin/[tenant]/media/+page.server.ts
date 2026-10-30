// The media library of a site in the admin (TODO #10b, brief #10 decision 10): upload and list
// here, each asset's details, edit and delete on its own page (`media/[id]`, brief #56 § C1), all
// through the same use cases HTTP and MCP expose, with native form posts and no JavaScript. The
// upload is a multipart form that takes several files at once (brief media-picker); the action
// hands each to `media.upload` as base64, the one contract of that use case (brief decision 6),
// and reports per file. Rejected: a multipart variant of the use case for the admin only, a
// second contract for one operation.
//
// The list shows each asset's thumbnail from the admin's own route (`media/[id]/thumb`): the
// admin is on the platform origin, the site's `/media/...` route on the tenant's hostnames. The
// view (grid or list) and the search are query parameters, so they survive paging and work
// without a script.
import { MAX_UPLOAD_BYTES, can, useCases } from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { text } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { uploadFile } from '#lib/server/admin/media-choices.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  const rt = runtime();
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const q = url.searchParams.get('q')?.trim().slice(0, 100) || undefined;
  const [list, usage] = await Promise.all([
    rt.invoker.run(useCases.listMedia, principal, { q, cursor, limit: 50 }),
    can(principal, 'tenant:admin') ? rt.invoker.run(useCases.getUsage, principal, {}) : null,
  ]);
  return {
    items: list.items.map((m) => ({
      ...m,
      thumb: m.variants.some((v) => v.name === 'thumb'),
    })),
    view: url.searchParams.get('view') === 'list' ? ('list' as const) : ('grid' as const),
    q: q ?? '',
    nextCursor: list.nextCursor,
    deleted: url.searchParams.get('done') === 'deleted',
    storage: usage?.storage ?? null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
};

export const actions: Actions = {
  upload: async ({ locals, url, params, request }) => {
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const data = await request.formData();
    const files = data.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0)
      return fail(400, { action: 'upload', error: 'admin.media.error.noFile' as UiKey });
    const access = text(data, 'access') === 'restricted' ? 'restricted' : 'public';
    // One at a time: each upload takes the tenant's media lock for the storage cap anyway.
    const outcomes = [];
    for (const file of files) outcomes.push(await uploadFile(principal, file, access));
    const uploaded = outcomes.flatMap((o) => (o.ok ? [o.choice] : []));
    const refused = outcomes.flatMap((o) =>
      o.ok ? [] : [{ filename: o.filename, error: o.error, what: o.what }]
    );
    const first = refused[0];
    if (uploaded.length === 0 && first)
      return fail(outcomes.length === 1 && !outcomes[0]!.ok ? outcomes[0]!.status : 400, {
        action: 'upload',
        error: first.error,
        what: first.what,
        filename: first.filename,
        refused: refused.slice(1),
      });
    return {
      action: 'upload',
      done: (uploaded.length === 1
        ? 'admin.media.done.uploaded'
        : 'admin.media.done.uploadedMany') as UiKey,
      filename: uploaded[0]!.label,
      n: uploaded.length,
      id: uploaded.length === 1 ? uploaded[0]!.id : undefined,
      refused,
    };
  },
};
