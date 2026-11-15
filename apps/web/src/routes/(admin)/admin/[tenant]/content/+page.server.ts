// The content list (TODO #11, brief content-editor § A1): pages or articles of this site as a
// work list. It follows the content locale (#66 PR 4): each row shows the title and the one status
// of that locale (ADR 018 rule 9; "changed" when a published locale has unpublished changes,
// rule 3), and the site's other locales as links with a word where the translation is behind or
// missing, read from each item's latest revision (`translationState`).
// Search, status, order and page are query parameters read by `content-list.ts` and answered by
// `content.item.list`, so every view has its own URL and works without JavaScript; the route
// only turns the view into links. The view is remembered for the way back from an item.
// A row's actions are what the operator may do with that item in the content locale:
// the live page and the preview are separate, because they differ exactly when both are offered;
// taking offline is for what is live, with the use case the edit screen uses. Duplicating opens
// the copy, like creating does (decision Jaap 2026-10-29).
// Where each translation stands, and an article's authors, section and tags, come with the list
// from core. The names of the authors and sections are read once per page, for the
// filter's choices and the columns; rejected: a name in the list's output, which would make a
// list of items depend on who may read which entity.
import { contentLocale } from '#lib/server/content/content-locale.js';
import { prepareListBulk } from '#lib/server/content/content-bulk.js';
import { fill, ui } from '../../../../../i18n/index.js';
import { randomUUID } from 'node:crypto';
import { redirect, type Cookies } from '@sveltejs/kit';
import { adminTimeZone, requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { act } from '#lib/server/admin/admin-actions.js';
import {
  can,
  contentPath,
  MAX_PAGE_SIZE,
  MAX_TRANSLATION_WALK,
  pickAny,
  ContentType,
  startSlug,
  useCases,
  type Principal,
} from '@mycel/core';
import { orNull } from '#lib/server/admin/admin-actions.js';
import {
  chooseListDisplay,
  columnsOf,
  isFiltered,
  LIST_PAGE_SIZES,
  LIST_SORTS,
  LIST_STATUSES,
  LIST_TRANSLATIONS,
  listChips,
  listDisplay,
  listInput,
  listParams,
  listPath,
  listViewFrom,
  NO_FILTERS,
  translationTooBroad,
  type ListView,
} from '#lib/server/content/content-list.js';
import { withAssigned } from '#lib/server/content/content-admin.js';
import { adminSiteUrls } from '#lib/server/site.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The authors and sections of this site as choices, with those `ids` name that the first page of
 * them does not hold; one that no longer exists shows its id. Two lists of a hundred are far past
 * a select anyone reads, so a larger site narrows by what is on the page or in the URL.
 */
async function articleEntities(
  principal: Principal,
  defaultLocale: string,
  ids: { authors: string[]; sections: string[] }
) {
  const { invoker } = runtime();
  const [{ people: authors }, { sections }] = await Promise.all([
    invoker.run(useCases.listPeople, principal, { limit: MAX_PAGE_SIZE }),
    invoker.run(useCases.listSections, principal, { limit: MAX_PAGE_SIZE }),
  ]);
  const author = (a: { id: string; name: string }) => ({ id: a.id, name: a.name });
  const section = (s: { id: string; slug: string; title: Record<string, string> }) => ({
    id: s.id,
    name: pickAny(s.title, defaultLocale) ?? s.slug,
  });
  return {
    authors: await withAssigned(
      ids.authors,
      authors.map(author),
      async (authorId) => {
        const a = await orNull(invoker.run(useCases.getPerson, principal, { personId: authorId }));
        return a && author(a);
      },
      (id) => ({ id, name: id })
    ),
    sections: await withAssigned(
      ids.sections,
      sections.map(section),
      async (sectionId) => {
        const found = await orNull(invoker.run(useCases.getSection, principal, { sectionId }));
        return found && section(found);
      },
      (id) => ({ id, name: id })
    ),
  };
}

/**
 * The rows the list URL asks for, as the page shows them: what a bulk selection is checked
 * against must be the page the operator was looking at, so `load` and the `bulk` action read it
 * here. A translation filter too broad to run is an empty page that says so, not an error.
 */
async function listRows(
  principal: Principal,
  tenant: { locales: readonly string[] },
  work: string,
  zone: string,
  url: URL,
  cookies: Cookies
) {
  const type = ContentType.safeParse(url.searchParams.get('type')).data ?? 'page';
  const others = tenant.locales.filter((l) => l !== work);
  const asked = listViewFrom(url.searchParams, type);
  // One locale has no other to stand behind.
  const view: ListView = tenant.locales.length > 1 ? asked : { ...asked, translation: null };
  const display = listDisplay(cookies, view, type);
  const page = await runtime()
    .invoker.run(
      useCases.listItems,
      principal,
      listInput(view, type, work, { per: display.per, zone, others })
    )
    .then(
      (listed) => ({ ...listed, tooBroad: false }),
      (error: unknown) => {
        if (!translationTooBroad(error)) throw error;
        return { items: [], total: 0, tooBroad: true };
      }
    );
  return { type, view, display, ...page };
}

export const load: PageServerLoad = async ({ parent, locals, url, params, cookies }) => {
  const { tenant, contentLocale: work, timeZone } = await parent();
  const principal = locals.principal!;
  const multi = tenant.locales.length > 1;
  const others = tenant.locales.filter((l) => l !== work);
  const { type, view, display, items, total, tooBroad } = await listRows(
    principal,
    tenant,
    work,
    timeZone,
    url,
    cookies
  );
  const { invoker } = runtime();
  const to = (change: Partial<ListView>) => listPath(params.tenant, type, { ...view, ...change });
  // A page past the end, after a narrower filter or a deletion: the last page there is.
  const pages = Math.max(1, Math.ceil(total / display.per));
  if (view.page > pages) redirect(303, to({ page: pages }));
  const first = (view.page - 1) * display.per;
  const siteUrl = items.some((i) =>
    i.publication.some((p) => p.locale === work && p.publishedRevisionId)
  )
    ? await adminSiteUrls(principal, tenant.slug)
    : null;
  const here = to({});
  const entities =
    type === 'article'
      ? await articleEntities(principal, tenant.defaultLocale, {
          authors: [
            ...new Set([
              ...(view.author ? [view.author] : []),
              ...items.flatMap((i) => i.authorIds),
            ]),
          ],
          sections: [
            ...new Set(
              [view.section, ...items.map((i) => i.sectionId)].filter((id) => id !== null)
            ),
          ],
        })
      : { authors: [], sections: [] };
  const authorName = new Map(entities.authors.map((a) => [a.id, a.name]));
  const sectionName = new Map(entities.sections.map((s) => [s.id, s.name]));
  return {
    canWrite: can(principal, 'content:write'),
    canPublish: can(principal, 'content:publish'),
    // The list came back from taking an item offline: it says so, in words.
    offline: url.searchParams.get('done') === 'offline',
    trashed: url.searchParams.get('done') === 'deleted',
    type,
    contentType: type,
    workLocale: work,
    multi,
    view: {
      q: view.q,
      status: view.status,
      author: view.author,
      section: view.section,
      tag: view.tag,
      from: view.from,
      to: view.to,
      translation: view.translation,
      sort: view.sort,
      dir: view.dir,
    },
    statuses: LIST_STATUSES,
    translations: LIST_TRANSLATIONS,
    authors: entities.authors,
    sections: entities.sections,
    filtered: isFiltered(view),
    tooBroad,
    walkLimit: MAX_TRANSLATION_WALK,
    // Each filter that is on, with the link that takes only that one off.
    chips: listChips(view).map((chip) => ({
      ...chip,
      value:
        chip.name === 'author'
          ? (authorName.get(chip.value) ?? chip.value)
          : chip.name === 'section'
            ? (sectionName.get(chip.value) ?? chip.value)
            : chip.value,
      href: to({ [chip.name]: NO_FILTERS[chip.name], page: 1 }),
    })),
    display,
    columnChoices: columnsOf(type),
    pageSizes: LIST_PAGE_SIZES,
    total,
    range: { from: first + 1, to: first + items.length },
    // What the filter form keeps besides its own fields: the type, the order and the display.
    keep: [['type', type], ...[...listParams({ ...view, ...NO_FILTERS, page: 1 })]] as [
      string,
      string,
    ][],
    links: {
      unpublish: `${here}&/unpublish`,
      duplicate: `${here}&/duplicate`,
      delete: `${here}&/delete`,
      trash: `/admin/${params.tenant}/content/trash`,
      display: `${here}&/display`,
      bulk: `${here}&/bulk`,
      clear: to({ ...NO_FILTERS, page: 1 }),
      sort: Object.fromEntries(
        LIST_SORTS.map((sort) => [
          sort,
          { asc: to({ sort, dir: 'asc', page: 1 }), desc: to({ sort, dir: 'desc', page: 1 }) },
        ])
      ),
      previous: view.page > 1 ? to({ page: view.page - 1 }) : undefined,
      next: view.page < pages ? to({ page: view.page + 1 }) : undefined,
    },
    items: items.map((i) => {
      const p = i.publication.find((x) => x.locale === work);
      const own = i.title[work];
      return {
        id: i.id,
        latestRevisionId: i.latestRevisionId,
        title: pickAny(i.title, work, i.defaultLocale) ?? '',
        // The title shown is another locale's: it carries that language.
        titleLocale: own ? work : i.title[i.defaultLocale] ? i.defaultLocale : null,
        slug: i.slug,
        created: i.createdAt,
        updated: i.updatedAt,
        authors: i.authorIds.map((id) => authorName.get(id) ?? id),
        section: i.sectionId ? (sectionName.get(i.sectionId) ?? i.sectionId) : null,
        tags: i.tags,
        live:
          siteUrl && p?.publishedRevisionId
            ? siteUrl(contentPath(i, work, tenant.defaultLocale))
            : null,
        // What the live page does not show yet, or there is no live page: the latest revision.
        preview:
          p && (!p.publishedRevisionId || p.hasUnpublishedChanges)
            ? `/admin/${params.tenant}/preview/item/${i.id}?revision=${i.latestRevisionId}&locale=${work}`
            : null,
        status: !p
          ? ('missing' as const)
          : p.hasUnpublishedChanges
            ? ('changed' as const)
            : p.status,
        // No translations at all: the document could not be read, which is not "missing".
        others: Object.keys(i.translations).length
          ? others.map((l) => ({
              locale: l,
              state: i.translations[l] ?? ('missing' as const),
            }))
          : [],
      };
    }),
  };
};

// Creation is a POST, so following or prefetching a link can never create content.
export const actions: Actions = {
  bulk: async (event) => {
    const result = await act(
      event,
      'bulk',
      {
        conflict: 'admin.content.error.invalid',
        invalid: 'admin.content.bulk.invalid',
      },
      async (principal, form) => {
        const { tenant } = await requireTenantPrincipal(
          event.locals,
          event.url,
          event.params.tenant
        );
        const work = contentLocale(event.cookies, tenant);
        const { zone } = await adminTimeZone(event.locals);
        const { items } = await listRows(principal, tenant, work, zone, event.url, event.cookies);
        return prepareListBulk(principal, form, items);
      }
    );
    if ('status' in result) return result;
    redirect(
      303,
      `/admin/${event.params.tenant}/content/bulk/${result.id}?${new URLSearchParams([...event.url.searchParams].filter(([key]) => !key.startsWith('/')))}`
    );
  },
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
          // A placeholder until the first save with a title; core then moves it there.
          slug: startSlug(type, randomUUID()),
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
  // The title says it is a copy in each locale's own words; a title at its limit is cut, so the
  // copy still has one instead of a refusal the operator cannot act on from the list.
  duplicate: async (event) => {
    const result = await act(
      event,
      'duplicate',
      { conflict: 'admin.content.error.invalid', invalid: 'admin.content.error.invalid' },
      async (principal, form) => {
        const itemId = String(form.get('item'));
        const { item } = await runtime().invoker.run(useCases.getItem, principal, { itemId });
        const title = Object.fromEntries(
          Object.entries(item.title).map(([locale, text]) => [
            locale,
            fill(ui(locale)('admin.content.row.duplicate.title'), { title: text }).slice(0, 200),
          ])
        );
        return runtime().invoker.run(useCases.duplicateItem, principal, { itemId, title });
      }
    );
    if ('status' in result) return result;
    redirect(303, `/admin/${event.params.tenant}/content/${result.item.id}`);
  },
  // A person's way of reading this list: back to the same view on its first page, now following
  // the choice. Asks only that the operator may be here; it changes nothing but their own browser.
  display: async (event) => {
    await requireTenantPrincipal(event.locals, event.url, event.params.tenant);
    const type = ContentType.safeParse(event.url.searchParams.get('type')).data ?? 'page';
    chooseListDisplay(event.cookies, event.params.tenant, type, await event.request.formData());
    const view = listViewFrom(event.url.searchParams, type);
    redirect(
      303,
      listPath(event.params.tenant, type, { ...view, page: 1, columns: null, per: null })
    );
  },
  // Back to the same view; the notice points at the trash, so the deletion can be undone.
  delete: async (event) => {
    const type = ContentType.safeParse(event.url.searchParams.get('type')).data ?? 'page';
    const view = listViewFrom(event.url.searchParams, type);
    const result = await act(
      event,
      'delete',
      {
        // `content.item.delete` has three conflicts: other items link to this one (the params name
        // them), it is the landing page of a campaign that is not archived (ADR 033 rule 9), or a
        // menu of the draft or published navigation links to it (ADR 036 rule 9).
        conflict: 'admin.content.delete.referenced',
        notFound: 'admin.content.delete.refused',
        issues: {
          'content.delete.campaign-landing': 'admin.content.delete.campaignLanding',
          'content.delete.in-navigation': 'admin.content.delete.inNavigation',
        },
      },
      async (principal, form) => {
        await runtime().invoker.run(useCases.deleteItem, principal, {
          itemId: String(form.get('item')),
        });
        return {};
      },
      async (e) => e.issues[0]?.params ?? {}
    );
    if ('status' in result) return result;
    redirect(303, `${listPath(event.params.tenant, type, view)}&done=deleted`);
  },
  // Back to the same view at the item's row; a filter the item no longer matches may hide it.
  unpublish: async (event) => {
    const type = ContentType.safeParse(event.url.searchParams.get('type')).data ?? 'page';
    const view = listViewFrom(event.url.searchParams, type);
    const result = await act(
      event,
      'unpublish',
      {
        conflict: 'admin.content.error.invalid',
        invalid: 'admin.content.publication.error.refused',
      },
      async (principal, form) => {
        const itemId = String(form.get('item'));
        await runtime().invoker.run(useCases.unpublishItem, principal, {
          itemId,
          locale: String(form.get('locale')),
        });
        return { itemId };
      }
    );
    if ('status' in result) return result;
    redirect(
      303,
      `${listPath(event.params.tenant, type, view)}&done=offline#item-${result.itemId}`
    );
  },
};
