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
// layout, the search, the filters, the order and the page are query parameters (`media-list.ts`),
// so they survive paging and work without a script.
import { MAX_UPLOAD_BYTES, can, useCases } from '@mycel/core';
import { fail, redirect } from '@sveltejs/kit';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { uploadFile } from '#lib/server/admin/media-choices.js';
import {
  MEDIA_KINDS,
  MEDIA_ORDERS,
  MEDIA_PAGE_SIZE,
  MEDIA_SHOWS,
  mediaChips,
  mediaFiltered,
  mediaListInput,
  mediaListParams,
  mediaListPath,
  mediaListViewFrom,
  MEDIA_NO_FILTERS,
  type MediaListView,
} from '#lib/server/admin/media-list.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url, params }) => {
  await parent();
  const principal = locals.principal!;
  const rt = runtime();
  const view = mediaListViewFrom(url.searchParams);
  const [list, usage] = await Promise.all([
    loaded(rt.invoker.run(useCases.listMedia, principal, mediaListInput(view))),
    can(principal, 'tenant:admin') ? rt.invoker.run(useCases.getUsage, principal, {}) : null,
  ]);
  const to = (change: Partial<MediaListView>) =>
    mediaListPath(params.tenant, { ...view, ...change });
  // A page past the end, after a narrower filter or a deletion: the last page there is. `done`
  // is not part of the view, and a deletion that empties the last page still has to say so.
  const pages = Math.max(1, Math.ceil(list.total / MEDIA_PAGE_SIZE));
  if (view.page > pages)
    redirect(
      303,
      mediaListPath(
        params.tenant,
        { ...view, page: pages },
        url.searchParams.get('done') ?? undefined
      )
    );
  const first = (view.page - 1) * MEDIA_PAGE_SIZE;
  return {
    items: list.items.map((m) => ({
      ...m,
      thumb: m.variants.some((v) => v.name === 'thumb'),
    })),
    view,
    kinds: MEDIA_KINDS,
    shows: MEDIA_SHOWS,
    orders: MEDIA_ORDERS,
    filtered: mediaFiltered(view),
    // Each filter that is on, with the link that takes only that one off.
    chips: mediaChips(view).map((chip) => ({
      ...chip,
      href: to({ [chip.name]: MEDIA_NO_FILTERS[chip.name], page: 1 }),
    })),
    total: list.total,
    range: { from: first + 1, to: first + list.items.length },
    // What the filter form keeps besides its own fields: the layout.
    keep: [...mediaListParams({ ...view, ...MEDIA_NO_FILTERS, order: 'created-desc', page: 1 })],
    links: {
      grid: to({ layout: 'grid', page: view.page }),
      list: to({ layout: 'list', page: view.page }),
      clear: to({ ...MEDIA_NO_FILTERS, page: 1 }),
      sort: Object.fromEntries(MEDIA_ORDERS.map((order) => [order, to({ order, page: 1 })])),
      previous: view.page > 1 ? to({ page: view.page - 1 }) : undefined,
      next: view.page < pages ? to({ page: view.page + 1 }) : undefined,
    },
    deleted: url.searchParams.get('done') === 'deleted',
    canWrite: can(principal, 'media:write'),
    // The list this page was, for the way back from a bulk action.
    query: url.searchParams.toString(),
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
      return fail(400, { action: 'upload', error: 'admin.media.error.noFile' as const });
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
      done:
        uploaded.length === 1
          ? ('admin.media.done.uploaded' as const)
          : ('admin.media.done.uploadedMany' as const),
      filename: uploaded[0]!.label,
      n: uploaded.length,
      id: uploaded.length === 1 ? uploaded[0]!.id : undefined,
      refused,
    };
  },
};
