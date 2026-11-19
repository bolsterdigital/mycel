// The dashboard (#66 PR 1, decision Jaap 2026-10-29): the tenant home shows its widgets before
// their data. "Usage and limits" is the usage the tenant home already showed; the use case is
// for site administrators, so another member sees that widget empty, like the rest. "Recently
// edited" and "Scheduled" ask `content.item.list`, the query of the content list, in
// the content locale, for anyone who may read content. Members, keys and domains moved verbatim
// to `leden` and `domeinen`.
// The list has no order on a scheduled moment, so the soonest five come from the 50 last saved;
// a site with more planned than that sees five of them, still all planned.
// "Sign-ups" (MY-259 PR 1) asks `supporter.activity.get` in the operator's time zone, for
// anyone who may read supporters; without that right the widget stays an empty contour.
// "Gifts" (PR 2) asks `donation.summary.get` in the same zone, only where the site takes gifts and
// the operator may read them; it has no contour, since without either there is nothing to show.
// "Visits" reads `analytics.settings.get`, a site administrator's read, so the widget is filled
// for them and stays a contour for everyone else.
// Rejected: a dashboard use case now (nothing to aggregate that the list cannot answer).
import { can, entitled, pickAny, useCases, type ContentItem } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { capabilities, contentLocale: work, timeZone } = await parent();
  const { invoker } = runtime();
  const principal = locals.principal!;
  const row = (i: ContentItem) => ({
    id: i.id,
    title: pickAny(i.title, work, i.defaultLocale) ?? '',
    updated: i.updatedAt,
    scheduledFor: i.publication.find((p) => p.locale === work)?.scheduledFor ?? null,
  });
  const content = can(principal, 'content:read')
    ? {
        recent: (
          await invoker.run(useCases.listItems, principal, { sort: 'updated', limit: 5 })
        ).items.map(row),
        scheduled: (
          await invoker.run(useCases.listItems, principal, {
            locale: work,
            status: 'scheduled',
            sort: 'updated',
            limit: 50,
          })
        ).items
          .map(row)
          .sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''))
          .slice(0, 5),
      }
    : null;
  const usage = capabilities.includes('tenant:admin')
    ? await runtime().invoker.run(useCases.getUsage, locals.principal!, {})
    : null;
  const activity = can(principal, 'supporters:read')
    ? await invoker.run(useCases.getSupporterActivity, principal, { timeZone })
    : null;
  const gifts =
    can(principal, 'donations:read') && entitled(principal, 'donations.enabled')
      ? await invoker.run(useCases.getDonationSummary, principal, { timeZone })
      : null;
  const visits = capabilities.includes('tenant:admin')
    ? await invoker.run(useCases.getAnalyticsSettings, principal, {})
    : null;
  return { usage, content, activity, gifts, visits };
};
