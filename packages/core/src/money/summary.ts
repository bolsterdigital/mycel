// What a site received lately (`donation.summary.get`, MY-259 PR 2): the money of this calendar
// month and the one before in the site's time zone, per currency, and how many recurring gifts and
// memberships run now. It is what the dashboard's "Gifts" widget shows and what an agent asks
// under the same `donations:read`. It names nobody: amounts and counts, no supporter, payment or
// provider reference (ADR 019 rule 7).
//
// The ledger is the source (ADR 005 rule 1): a month holds the payment entries that reached `paid`
// in it, minus those that reached `refunded` or `charged_back` in it, each by the moment of its
// entry. So a gift paid in October and refunded in November counts in October and is taken off in
// November, as a bank statement reads, and a month already shown does not change afterwards. Per
// currency, never converted (rule 8). "Running" is the subscriptions `active` now; a paused one
// charges nothing and does not count.
//
// Rejected: summing the `payments` rows by status (a refunded gift would vanish from the month it
// was paid in, and a month would change after the fact), a stored monthly total (a second source
// next to the ledger) and a sliding 30 days as in `supporter.activity.get` (money is read per
// calendar month, by the treasurer as well as the bank).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { DEFAULT_TIME_ZONE, IanaTimeZone, localDate, startOfLocalDay } from '../util/time-zone.js';
import { Currency, type LedgerEntry } from './model.js';
import './ports.js';

/** A ledger entry that moved money, as the summary needs it. */
export type MoneyMovement = Pick<LedgerEntry, 'to' | 'amount' | 'currency' | 'at'>;

/** The statuses whose entry takes money back off a month. */
const RETURNED = new Set(['refunded', 'charged_back']);

/** The first day (`YYYY-MM-01`) of the month `months` away from the month of `date`. */
function monthStart(date: string, months: number): string {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const at = new Date(Date.UTC(year, month - 1 + months, 1));
  return at.toISOString().slice(0, 10);
}

/** This month up to `until` and the whole month before, in `zone`. */
export function summaryMonths(until: Date, zone: string) {
  const first = monthStart(localDate(until, zone), 0);
  return {
    from: startOfLocalDay(first, zone),
    previousFrom: startOfLocalDay(monthStart(first, -1), zone),
  };
}

const Count = z.number().int().nonnegative();
/** Minor units; a month can hand back more than it received, so it may be negative. */
const Amount = z.number().int();

const MonthTotals = z.object({
  /** Paid in the month, minus what was refunded or charged back in it. */
  net: Amount,
  /** What was refunded or charged back in the month. */
  returned: Amount.nonnegative(),
  /** Payments that reached `paid` in the month. */
  gifts: Count,
});

export const DonationSummary = z.object({
  /** Where this month starts, the moment the summary ends, where last month starts, the zone. */
  from: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  previousFrom: z.string().datetime({ offset: true }),
  timeZone: z.string(),
  /** One row per currency with money in either month, by currency code. */
  currencies: z.array(
    z.object({ currency: Currency, month: MonthTotals, previousMonth: MonthTotals })
  ),
  /** Subscriptions that run now, by kind. */
  running: z.object({ donations: Count, memberships: Count }),
});
export type DonationSummary = z.infer<typeof DonationSummary>;

export const getDonationSummary = defineUseCase({
  name: 'donation.summary.get',
  kind: 'query',
  requires: 'donations:read',
  description:
    "What the site received: per currency, the money paid this calendar month and last month (refunds and chargebacks of that month taken off, by the moment they happened) and how many payments; and how many recurring gifts and memberships are active now. Numbers only, no donors. `timeZone` decides where a month starts (default Europe/Amsterdam); `until` ends this month's count at another moment than now.",
  input: z
    .object({
      timeZone: IanaTimeZone.default(DEFAULT_TIME_ZONE),
      until: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  output: DonationSummary,
  examples: [{ input: {} }, { input: { timeZone: 'Europe/Berlin' } }],
  async handler(ctx, { timeZone, until: end }) {
    const until = end ? new Date(end) : ctx.clock.now();
    const { from, previousFrom } = summaryMonths(until, timeZone);
    const empty = () => ({ net: 0, returned: 0, gifts: 0 });
    const rows = new Map<
      string,
      { month: z.infer<typeof MonthTotals>; previousMonth: z.infer<typeof MonthTotals> }
    >();
    for (const m of await ctx.payments.movements(previousFrom, until)) {
      const row = rows.get(m.currency) ?? { month: empty(), previousMonth: empty() };
      rows.set(m.currency, row);
      const totals = Date.parse(m.at) >= from.getTime() ? row.month : row.previousMonth;
      if (m.to === 'paid') {
        totals.net += m.amount;
        totals.gifts += 1;
      } else if (RETURNED.has(m.to)) {
        totals.net -= m.amount;
        totals.returned += m.amount;
      }
    }
    const running = await ctx.subscriptions.countActive();
    return {
      from: from.toISOString(),
      until: until.toISOString(),
      previousFrom: previousFrom.toISOString(),
      timeZone,
      currencies: [...rows]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, row]) => ({ currency, ...row })),
      running: { donations: running.donation, memberships: running.membership },
    };
  },
});
