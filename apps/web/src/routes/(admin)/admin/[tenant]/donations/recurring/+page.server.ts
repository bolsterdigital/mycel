// The site's monthly and yearly gifts (`donation.subscription.list`, MY-254 PR 2), the second list
// of Donations: who gives, how much per interval, where it stands, when the next charge is due and
// how many charges failed in a row. Newest first, narrowed by a GET form to one status, fifty at
// a time. Only holders of `donations:read` get here, like the payments list; who gives is a link
// to their page for a reader who may also read supporters. Rejected: one table for payments and
// subscriptions (a payment happened once, a subscription goes on; their columns differ).
import { SubscriptionStatus, can, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'donations:read')) refuse(403);
  const asked = SubscriptionStatus.safeParse(url.searchParams.get('status'));
  const status = asked.success ? asked.data : '';
  const offset = Math.min(Math.max(Number(url.searchParams.get('from')) || 0, 0), 100_000);
  const page = await loaded(
    runtime().invoker.run(useCases.listSubscriptions, principal, {
      limit: PAGE_SIZE,
      offset,
      ...(status ? { status } : {}),
    })
  );
  const emails = new Map(page.supporters.map((s) => [s.id, s.email]));
  const href = (from: number) =>
    `?${new URLSearchParams({ ...(status ? { status } : {}), ...(from ? { from: String(from) } : {}) })}`;
  return {
    subscriptions: page.subscriptions.map((s) => ({
      id: s.id,
      kind: s.kind,
      amount: s.amount,
      currency: s.currency,
      interval: s.interval,
      status: s.status,
      nextChargeAt: s.nextChargeAt,
      failedAttempts: s.failedAttempts,
      supporterId: s.supporterId,
      email: s.supporterId ? (emails.get(s.supporterId) ?? null) : null,
    })),
    status,
    filters: SubscriptionStatus.options,
    filtered: Boolean(status),
    linkSupporters: can(principal, 'supporters:read'),
    paging: {
      ...(offset ? { previous: href(Math.max(offset - PAGE_SIZE, 0)) } : {}),
      ...(page.nextOffset !== null ? { next: href(page.nextOffset) } : {}),
    },
  };
};
