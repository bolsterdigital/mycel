// The content list (TODO #11, brief content-editor § A1): pages or articles of this site as a
// work list. It follows the content locale (#66 PR 4): each row shows the title and the one status
// of that locale (ADR 018 rule 9; "changed" when a published locale has unpublished changes,
// rule 3), and the site's other locales as links with a word where the translation is behind or
// missing, read from each item's latest revision (`translationState`).
// Search, status, order and page are query parameters read by `content-list.ts` and answered by
// `content.item.list`, so every view has its own URL and works without JavaScript; the route
// only turns the view into links. The view is remembered for the way back from an item.
// The latest revision is one read per row, a page of at most 20; rejected for now: a translation
// summary in `content.item.list` itself, which changes core's output for every caller.
import { ui } from '../../../../../i18n/index.js';
import { randomUUID } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { act } from '#lib/server/admin/admin-actions.js';
import { pickAny, ContentType, useCases } from '@mycel/core';
import {
  isFiltered,
  LIST_PAGE_SIZE,
  LIST_SORTS,
  LIST_STATUSES,
  listInput,
  listParams,
  listPath,
  listViewFrom,
  rememberList,
  type ListView,
} from '#lib/server/content/content-list.js';
import { translationState } from '#lib/server/content/content-locale.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url, params, cookies }) => {
  const { tenant, contentLocale: work } = await parent();
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  const view = listViewFrom(url.searchParams);
  const { invoker } = runtime();
  const principal = locals.principal!;
  const { items, total } = await invoker.run(
    useCases.listItems,
    principal,
    listInput(view, type, work)
  );
  const to = (change: Partial<ListView>) => listPath(params.tenant, type, { ...view, ...change });
  // A page past the end, after a narrower filter or a deletion: the last page there is.
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  if (view.page > pages) redirect(303, to({ page: pages }));
  rememberList(cookies, params.tenant, type, view);
  const multi = tenant.locales.length > 1;
  const first = (view.page - 1) * LIST_PAGE_SIZE;
  return {
    type,
    contentType: type,
    workLocale: work,
    view: { q: view.q, status: view.status, sort: view.sort, dir: view.dir },
    statuses: LIST_STATUSES,
    filtered: isFiltered(view),
    total,
    range: { from: first + 1, to: first + items.length },
    // What the filter form keeps besides its own fields: the list's type and its order.
    keep: [['type', type], ...[...listParams({ ...view, q: '', status: null, page: 1 })]] as [
      string,
      string,
    ][],
    links: {
      clear: to({ q: '', status: null, page: 1 }),
      sort: Object.fromEntries(
        LIST_SORTS.map((sort) => [
          sort,
          { asc: to({ sort, dir: 'asc', page: 1 }), desc: to({ sort, dir: 'desc', page: 1 }) },
        ])
      ),
      previous: view.page > 1 ? to({ page: view.page - 1 }) : undefined,
      next: view.page < pages ? to({ page: view.page + 1 }) : undefined,
    },
    items: await Promise.all(
      items.map(async (i) => {
        const doc = multi
          ? (await invoker.run(useCases.getItem, principal, { itemId: i.id })).revision.document
          : null;
        const p = i.publication.find((x) => x.locale === work);
        const own = i.title[work];
        return {
          id: i.id,
          title: pickAny(i.title, work, i.defaultLocale) ?? '',
          // The title shown is another locale's: it carries that language.
          titleLocale: own ? work : i.title[i.defaultLocale] ? i.defaultLocale : null,
          updated: i.updatedAt,
          status: !p
            ? ('missing' as const)
            : p.hasUnpublishedChanges
              ? ('changed' as const)
              : p.status,
          others: doc
            ? tenant.locales
                .filter((l) => l !== work)
                .map((l) => ({ locale: l, state: translationState(doc, l) }))
            : [],
        };
      })
    ),
  };
};

// Creation is a POST, so following or prefetching a link can never create content.
export const actions: Actions = {
  create: async (event) => {
    const result = await act(
      event,
      'create',
      {
        conflict: 'admin.content.error.slugTaken',
        invalid: 'admin.content.error.invalid',
      },
      async (principal, form) => {
        const { tenant } = await requireTenantPrincipal(
          event.locals,
          event.url,
          event.params.tenant
        );
        const type = ContentType.parse(form.get('type'));
        return runtime().invoker.run(useCases.createItem, principal, {
          slug: `${type}-${randomUUID()}`,
          document: {
            type,
            title: { [tenant.defaultLocale]: ui(tenant.defaultLocale)('admin.content.untitled') },
            defaultLocale: tenant.defaultLocale,
            locales: tenant.locales,
            blocks: [],
          },
        });
      }
    );
    if ('status' in result) return result;
    redirect(303, `/admin/${event.params.tenant}/content/${result.item.id}`);
  },
};
