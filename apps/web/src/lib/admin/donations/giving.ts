// How a monthly or yearly gift reads in the admin (MY-254 PR 2): "€ 10 per maand", its status as
// a word with a tone, and the two tabs of Donations. Pure and client-safe, like ../format.ts; the
// list, the detail, the one-off list and the supporter's page share it so a gift reads the same
// everywhere. Rejected: the words in core (copy belongs in the web catalogue, ADR 007).

import type { SubscriptionStatus } from '@mycel/core';
import type { UiKey } from '../../../i18n/en.js';
import { fill } from '../../../i18n/index.js';
import { formatMoney } from '../../money.js';

type T = (key: UiKey) => string;

/** "€ 10 per maand", "€ 120 per jaar". */
export function perInterval(
  t: T,
  amount: number,
  currency: string,
  interval: 'month' | 'year',
  locale: string
): string {
  return fill(t(`admin.giving.per.${interval}`), {
    amount: formatMoney(amount, currency, locale),
  });
}

const STATUS = {
  pending: 'admin.giving.status.pending',
  active: 'admin.giving.status.active',
  paused: 'admin.giving.status.paused',
  cancelled: 'admin.giving.status.cancelled',
  ended: 'admin.giving.status.ended',
} as const satisfies Record<SubscriptionStatus, UiKey>;

export const givingStatus = (t: T, s: SubscriptionStatus): string => t(STATUS[s]);

export const givingTone = (s: SubscriptionStatus): 'success' | 'neutral' | 'warning' =>
  s === 'active' ? 'success' : s === 'pending' || s === 'paused' ? 'neutral' : 'warning';

/** The two lists of Donations: every payment, and the gifts that recur. */
export function donationTabs(t: T, base: string, current: 'payments' | 'recurring') {
  return [
    { href: base, label: t('admin.donations.tab.payments'), current: current === 'payments' },
    {
      href: `${base}/recurring`,
      label: t('admin.donations.tab.recurring'),
      current: current === 'recurring',
    },
  ];
}
