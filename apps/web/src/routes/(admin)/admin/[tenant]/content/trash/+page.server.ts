// The trash of pages and articles (ADR 030): what was deleted, restored one at a time, because a
// restore is a decision about one address. It reads through `content.trash.list`, which asks
// `content:publish`, the right that deleted it.
import { useCases } from '@mycel/core';
import { redirect } from '@sveltejs/kit';
import { act, loaded } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const pageOf = (url: URL) => Math.max(1, Number(url.searchParams.get('page')) || 1);

export const load: PageServerLoad = async ({ parent, locals, url, params }) => {
  await parent();
  const page = pageOf(url);
  const { items, total } = await loaded(
    runtime().invoker.run(useCases.listContentTrash, locals.principal!, {
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const here = `/admin/${params.tenant}/content/trash`;
  if (page > pages) redirect(303, `${here}?page=${pages}`);
  const first = (page - 1) * PAGE_SIZE;
  return {
    items,
    total,
    range: { from: first + 1, to: first + items.length },
    previous: page > 1 ? `${here}?page=${page - 1}` : undefined,
    next: page < pages ? `${here}?page=${page + 1}` : undefined,
    overview: `/admin/${params.tenant}/content`,
  };
};

export const actions: Actions = {
  restore: (event) =>
    act(
      event,
      'restore',
      {
        conflict: 'admin.content.delete.refused',
        notFound: 'admin.content.trash.notFound',
      },
      async (principal, form) => {
        const { item, slugChanged } = await runtime().invoker.run(useCases.restoreItem, principal, {
          itemId: String(form.get('item')),
        });
        return {
          restored: {
            id: item.id,
            title: item.title[item.defaultLocale] ?? item.slug,
            slug: item.slug,
            slugChanged,
          },
        };
      }
    ),
};
