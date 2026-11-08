// Delete a selection of the media library: the page opens from the
// list's selection form, says what will happen, and shows the result per file with the two ways
// back: restoring what went, trying again what was in use. Every step is a native form.
// Rejected: `media.delete` in a loop here (a partial failure would have no durable answer) and a
// run record like the content bulk's: nothing here publishes, and the trash is the undo.
import { can, useCases } from '@mycel/core';
import { redirect } from '@sveltejs/kit';
import { act } from '#lib/server/admin/admin-actions.js';
import {
  liveMedia,
  mediaListHref,
  postedMediaIds,
  selectedMediaIds,
} from '#lib/server/admin/media-bulk.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url, params }) => {
  await parent();
  const principal = locals.principal!;
  const back = mediaListHref(params.tenant, url.searchParams.get('back'));
  if (!can(principal, 'media:write')) redirect(303, back);
  const files = await liveMedia(principal, selectedMediaIds(url.searchParams));
  return {
    files: files.map((m) => ({ id: m.id, filename: m.filename, usageCount: m.usageCount })),
    back,
    trash: `/admin/${params.tenant}/media/trash`,
  };
};

const copy = {
  conflict: 'admin.media.error.notFound',
  invalid: 'admin.media.bulk.none',
  notFound: 'admin.media.error.notFound',
} as const;

export const actions: Actions = {
  delete: (event) =>
    act(event, 'delete', copy, async (principal, form) => {
      const ids = postedMediaIds(form);
      const names = new Map((await liveMedia(principal, ids)).map((m) => [m.id, m.filename]));
      const { results } = await runtime().invoker.run(useCases.bulkDeleteMedia, principal, { ids });
      return {
        action: 'delete',
        results: results.map((r) => ({ ...r, filename: names.get(r.id) ?? r.id })),
      };
    }),
  restore: (event) =>
    act(event, 'restore', copy, async (principal, form) => {
      const ids = postedMediaIds(form);
      const { results } = await runtime().invoker.run(useCases.restoreMedia, principal, { ids });
      const names = new Map((await liveMedia(principal, ids)).map((m) => [m.id, m.filename]));
      return {
        action: 'restore',
        results: results.map((r) => ({ ...r, filename: names.get(r.id) ?? r.id })),
      };
    }),
};
