// The donor's return page and the hop to the checkout (brief MY-252 PR 2), for the route
// `[[locale]]/donation/[token]`: `donation.return.check` (cause `return`) asks the provider where
// the payment of this token stands and records a step, as a webhook would. The page shows paid,
// failed, or still being processed with a link to look again; the amount and nothing about who
// gave. On the hop from the donation form (`?pay=1`) an open payment sends the visitor on to the
// checkout the use case names for this token, never to an address from the query: CSP
// `form-action 'self'` refuses a form post that redirects to another origin, and a checkout is
// one. `back` is the page the form was on, kept only when it is a plain site path.
//
// The visitor carries only `donations:write` and reaches only `donation.return.check` among the
// donation use cases (ANONYMOUS_USE_CASES). Rejected: reading the status from the provider's
// redirect query (a visitor could type it), and polling with JavaScript (a link does it without).

import { UseCaseError, anonymousPrincipal, useCases } from '@mycel/core';
import { formatMoney } from '../../../money.js';
import { refuse } from '../../http/refuse.js';
import { runtime } from '../../runtime.js';
import { sitePath, siteTenant, type Site } from '../../site.js';

/** A site path of slugs only: no scheme, no host, no `//`. */
const PLAIN_PATH = /^\/(?!\/)[a-z0-9/_-]*$/i;

export interface DonationReturn {
  state: 'paid' | 'pending' | 'failed';
  amount: string | null;
  /** A monthly or yearly gift: its first payment says how often it is given from now on. */
  interval: 'month' | 'year' | null;
  /** The page to go back or try again on. */
  back: string;
  /** This page again, to look whether a pending payment settled. */
  again: string;
  /** The checkout to go on to: only on the hop from the form, while the payment is open. */
  pay: string | null;
}

export async function loadDonationReturn(
  site: Site,
  locale: string,
  token: string,
  url: URL
): Promise<DonationReturn> {
  const visitor = anonymousPrincipal(siteTenant(site), ['donations:write']);
  let state: DonationReturn['state'] = 'pending';
  let amount: string | null = null;
  let checkout: string | null = null;
  let interval: DonationReturn['interval'] = null;
  try {
    const outcome = await runtime().invoker.run(useCases.checkDonationReturn, visitor, { token });
    amount = formatMoney(outcome.amount, outcome.currency, locale);
    checkout = outcome.checkoutUrl;
    interval = outcome.interval;
    state =
      outcome.status === 'paid'
        ? 'paid'
        : outcome.status === 'created' || outcome.status === 'open'
          ? 'pending'
          : 'failed';
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') refuse(404);
    // The provider did not answer: the payment may well be paid; it reads as being processed.
    if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
  }
  const asked = url.searchParams.get('back');
  const back = asked && PLAIN_PATH.test(asked) ? asked : null;
  return {
    state,
    amount,
    interval,
    back: sitePath(site, back ?? '/'),
    again: back ? `${url.pathname}?back=${encodeURIComponent(back)}` : url.pathname,
    pay: url.searchParams.has('pay') && state === 'pending' ? checkout : null,
  };
}
