// The site's donations (`donation.list`, brief MY-252 PR 2): amount, status and date, newest
// first, narrowed by a GET form to one status, fifty at a time. Only holders of
// `donations:read` get here; the menu hides the entry from everyone else and this load refuses
// them. Who gave is a link to their page, shown to a reader who may also read supporters (the
// use case returns the addresses only then); an anonymous gift or an erased donor reads as such.
// Rejected: a column with the provider's reference (a person asking about a gift names the
// amount and the day; the reference is on the donation's ledger when it gets a page).
import { PaymentStatus, can, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
/** The statuses the filter offers: the ones a payment ends in, and the one it waits in. */
const FILTERS = ['paid', 'open', 'failed', 'expired', 'refunded'] as const;

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'donations:read')) refuse(403);
  const asked = PaymentStatus.safeParse(url.searchParams.get('status'));
  const status =
    asked.success && (FILTERS as readonly string[]).includes(asked.data) ? asked.data : '';
  const offset = Math.min(Math.max(Number(url.searchParams.get('from')) || 0, 0), 100_000);
  const page = await loaded(
    runtime().invoker.run(useCases.listDonations, principal, {
      limit: PAGE_SIZE,
      offset,
      ...(status ? { status } : {}),
    })
  );
  const emails = new Map(page.supporters.map((s) => [s.id, s.email]));
  const href = (from: number) =>
    `?${new URLSearchParams({ ...(status ? { status } : {}), ...(from ? { from: String(from) } : {}) })}`;
  return {
    donations: page.donations.map((d) => ({
      id: d.id,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      createdAt: d.createdAt,
      supporterId: d.supporterId,
      email: d.supporterId ? (emails.get(d.supporterId) ?? null) : null,
    })),
    status,
    filters: FILTERS,
    filtered: Boolean(status),
    linkSupporters: can(principal, 'supporters:read'),
    paging: {
      ...(offset ? { previous: href(Math.max(offset - PAGE_SIZE, 0)) } : {}),
      ...(page.nextOffset !== null ? { next: href(page.nextOffset) } : {}),
    },
  };
};
