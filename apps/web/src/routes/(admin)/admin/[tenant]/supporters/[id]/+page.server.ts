// One supporter of the site (`supporter.timeline.get`, brief MY-251 PR 2): who they are, their
// lists, the campaigns they took part in, the access they hold and what they did, read-only.
// Only readers of `supporters:read` get here. An id that is no supporter of this site, an erased
// one included, is 404; the address is in the page and nowhere else: nothing here logs it
// (ADR 019 rule 7).
//
// The names a sentence needs come with the same read: list names from the site's signup forms,
// campaign titles from the participations (only for a principal who reads content), tier names
// from the standing grants. Rejected: a read per event for its name (a timeline of a hundred
// rows would ask a hundred times for a handful of names).
import { can, isUuid, pickAny, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { signupLists } from '#lib/server/mail/newsletter.js';
import { runtime } from '#lib/server/runtime.js';
import { langOf } from '../../../../../../i18n/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { tenant, locale } = await parent();
  const principal = locals.principal!;
  if (!can(principal, 'supporters:read')) refuse(403);
  if (!isUuid(params.id)) refuse(404);
  const timeline = await loaded(
    runtime().invoker.run(useCases.getSupporterTimeline, principal, { supporterId: params.id })
  );
  const lists = Object.fromEntries(
    (await signupLists(principal, langOf(locals))).map((l) => [l.id, l.label])
  );
  const participations = timeline.participations.map((p) => ({
    campaignId: p.campaignId,
    kind: p.kind,
    confirmedAt: p.confirmedAt,
    withdrawnAt: p.withdrawnAt,
    title: p.landing
      ? (pickAny(p.landing.title, locale, tenant.defaultLocale) ?? p.landing.slug)
      : null,
    href: p.landing ? `/admin/${tenant.slug}/content/${p.landing.itemId}#campaign` : null,
  }));
  const access = timeline.access.map((a) => ({
    tierId: a.tierId,
    name: pickAny(a.name, locale, tenant.defaultLocale) ?? a.tierId,
    grantKind: a.grantKind,
    until: a.until,
    standing: a.standing,
  }));
  return {
    supporter: timeline.supporter,
    participations,
    access,
    events: timeline.events,
    eventTotal: timeline.eventTotal,
    names: {
      lists,
      campaigns: Object.fromEntries(
        participations.flatMap((p) => (p.title ? [[p.campaignId, p.title]] : []))
      ),
      tiers: Object.fromEntries(access.map((a) => [a.tierId, a.name])),
    },
  };
};
