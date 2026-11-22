// The counter of a campaign in the unit of its kind (ADR 033 rule 8), for the views and the card
// alike: people from the participation rows (plus the anonymous erased ones and the starting
// count, MY-288), or for a fundraiser the paid payments that name it, summed in the tenant
// currency. Read from the rows each time, never kept as a running number, so a rebuild cannot
// disagree with what a page showed.
// Rejected: a fundraiser counted through participation rows (a gift is no signature to confirm or
// withdraw) and a sum kept on the campaign row (a second record of money beside the ledger).
import type { TransactionContext } from '../ports.js';
import { SUPPORTED_CURRENCIES } from '../money/model.js';
import '../money/ports.js';
import type { Campaign, Tally } from './model.js';
import './ports.js';

/** The tenant's one currency (ADR 005 rule 8) until a tenant chooses its own. */
const CURRENCY = SUPPORTED_CURRENCIES[0]!;

export async function tallies(
  ctx: TransactionContext,
  campaigns: readonly Campaign[]
): Promise<Map<string, Tally>> {
  const people = campaigns.filter((c) => c.kind !== 'fundraiser').map((c) => c.id);
  const funds = campaigns.filter((c) => c.kind === 'fundraiser').map((c) => c.id);
  const active = people.length ? await ctx.campaigns.activeCounts(people) : new Map();
  const raised = funds.length ? await ctx.payments.raised(funds, CURRENCY) : new Map();
  return new Map(
    campaigns.map((c): [string, Tally] => {
      if (c.kind !== 'fundraiser')
        return [
          c.id,
          { participants: (active.get(c.id) ?? 0) + c.erasedCount + c.startingCount, raised: null },
        ];
      const sum = raised.get(c.id) ?? { amount: 0, gifts: 0 };
      return [
        c.id,
        { participants: sum.gifts, raised: { amount: sum.amount, currency: CURRENCY } },
      ];
    })
  );
}

export const tallyOf = async (ctx: TransactionContext, campaign: Campaign): Promise<Tally> =>
  (await tallies(ctx, [campaign])).get(campaign.id)!;
