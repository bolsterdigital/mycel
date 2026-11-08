// The trash of the media library: what was deleted in the last 30 days, restored per
// selection. It reads through `media.trash.list`, which asks `media:write`: a reader of the
// library has no business with deleted files. A list, no grid: a deleted file has no thumbnail
// route, and the name and the date are what the choice turns on.
import { useCases } from '@mycel/core';
import { redirect } from '@sveltejs/kit';
import { act, loaded } from '#lib/server/admin/admin-actions.js';
import { postedMediaIds } from '#lib/server/admin/media-bulk.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const pageOf = (url: URL) => Math.max(1, Number(url.searchParams.get('page')) || 1);

export const load: PageServerLoad = async ({ parent, locals, url, params }) => {
  await parent();
  const page = pageOf(url);
  const { items, total } = await loaded(
    runtime().invoker.run(useCases.listMediaTrash, locals.principal!, {
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const here = `/admin/${params.tenant}/media/trash`;
  if (page > pages) redirect(303, `${here}?page=${pages}`);
  const first = (page - 1) * PAGE_SIZE;
  return {
    items,
    total,
    range: { from: first + 1, to: first + items.length },
    previous: page > 1 ? `${here}?page=${page - 1}` : undefined,
    next: page < pages ? `${here}?page=${page + 1}` : undefined,
    library: `/admin/${params.tenant}/media`,
  };
};

export const actions: Actions = {
  restore: (event) =>
    act(
      event,
      'restore',
      {
        conflict: 'admin.media.error.notFound',
        invalid: 'admin.media.bulk.none',
        notFound: 'admin.media.error.notFound',
      },
      async (principal, form) => {
        const ids = postedMediaIds(form);
        const names = new Map(
          form
            .getAll('name')
            .map(String)
            .map((pair) => [pair.slice(0, 36), pair.slice(37)])
        );
        const { results } = await runtime().invoker.run(useCases.restoreMedia, principal, { ids });
        return { results: results.map((r) => ({ ...r, filename: names.get(r.id) ?? r.id })) };
      }
    ),
};
