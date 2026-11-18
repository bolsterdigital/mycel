// One supporter of the site (`supporter.timeline.get`, brief MY-251 PR 2): who they are, their
// lists, the campaigns they took part in, the access they hold, what they give every month or year
// (MY-254, with `donations:read`) and what they did. Only readers of
// `supporters:read` get here, and the page changes one thing: an administrator gives or takes
// back access to a tier (`supporter.access_grant.create|revoke`, ADR 016). Those use cases hold the
// authorization (`tenant:admin`) and the tenant boundary; the load only decides whether to show
// the two forms, so a member without the capability does not fill them in for nothing. An id that is no supporter of this site, an erased
// one included, is 404; the address is in the page and nowhere else: nothing here logs it
// (ADR 019 rule 7).
//
// The names a sentence needs come with the same read: list names from the site's signup forms,
// campaign titles from the participations (only for a principal who reads content), tier names
// from the standing grants. Rejected: a read per event for its name (a timeline of a hundred
// rows would ask a hundred times for a handful of names).
import { can, isUuid, pickAny, useCases, UseCaseError } from '@mycel/core';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { adminTimeZone } from '#lib/server/admin/admin.js';
import { fromLocalInput } from '#lib/server/content/content-admin-publication.js';
import { refuse } from '#lib/server/http/refuse.js';
import { signupLists } from '#lib/server/mail/newsletter.js';
import { runtime } from '#lib/server/runtime.js';
import { langOf } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

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
  // The tiers an administrator can give; without `content:read` there is no list to choose from.
  const canGrant = can(principal, 'tenant:admin') && can(principal, 'content:read');
  const tiers = canGrant
    ? (await loaded(runtime().invoker.run(useCases.listAccessTiers, principal, {}))).tiers
        .sort((a, b) => a.order - b.order)
        .map((tier) => ({
          id: tier.id,
          name: pickAny(tier.name, locale, tenant.defaultLocale) ?? tier.slug,
        }))
    : [];
  // What they give every month or year (MY-254), for a reader who may read donations.
  const giving = can(principal, 'donations:read')
    ? (
        await loaded(
          runtime().invoker.run(useCases.listSubscriptions, principal, {
            supporterId: params.id,
            limit: 20,
          })
        )
      ).subscriptions
        .filter((s) => s.status === 'active' || s.status === 'paused')
        .map((s) => ({
          id: s.id,
          amount: s.amount,
          currency: s.currency,
          interval: s.interval,
          paused: s.status === 'paused',
          // A membership reads "Lid (Vrienden) tot 1 maart" (MY-254 PR 4).
          member:
            s.kind === 'membership' && s.paidThrough
              ? {
                  tier: access.find((a) => a.tierId === s.tierId)?.name ?? '',
                  paidThrough: s.paidThrough,
                }
              : null,
        }))
    : [];
  return {
    canGrant,
    tiers,
    giving,
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
      // A tier whose grant was taken back is no longer in `access`, but its events still name it.
      tiers: Object.fromEntries([
        ...tiers.map((tier) => [tier.id, tier.name]),
        ...access.map((a) => [a.tierId, a.name]),
      ]),
    },
  };
};

const copy = {
  conflict: 'admin.supporter.grant.conflict',
  notFound: 'admin.supporter.grant.gone',
  invalid: 'admin.supporter.grant.invalid',
} as const;

export const actions: Actions = {
  grant: (event) =>
    act(event, 'grant', copy, async (principal, data) => {
      // The end is a wall-clock moment in the admin's zone, like a campaign window; empty is none.
      const until = text(data, 'until').trim();
      const end = until ? fromLocalInput(until, (await adminTimeZone(event.locals)).zone) : null;
      if (until && !end) throw new UseCaseError('invalid_input', 'until is not a moment');
      await runtime().invoker.run(useCases.createAccessGrant, principal, {
        supporterId: event.params.id,
        tierId: text(data, 'tierId'),
        kind: text(data, 'kind') as 'comp' | 'gift',
        reason: text(data, 'reason'),
        ...(end ? { until: end.toISOString() } : {}),
      });
      return { action: 'grant', done: 'admin.supporter.grant.done' as const };
    }),
  revoke: (event) =>
    act(event, 'revoke', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.revokeAccessGrant, principal, {
        supporterId: event.params.id,
        tierId: text(data, 'tierId'),
        reason: text(data, 'reason'),
      });
      return { action: 'revoke', done: 'admin.supporter.revoke.done' as const };
    }),
};
