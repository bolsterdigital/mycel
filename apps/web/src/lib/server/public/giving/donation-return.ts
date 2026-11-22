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
import { plainSitePath } from '../content-route.js';

export interface DonationReturn {
  state: 'paid' | 'pending' | 'failed';
  amount: string | null;
  /** A monthly or yearly gift: its first payment says how often it is given from now on. */
  interval: 'month' | 'year' | null;
  /** The first payment of a membership (MY-254 PR 4): the page offers a sign-in link. */
  membership: boolean;
  /** The sign-in link was just asked for (`?signin=sent`). */
  signinSent: boolean;
  /** `&back=…` for the sign-in form's action, so the page after it keeps its way back. */
  backQuery: string;
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
  let membership = false;
  try {
    const outcome = await runtime().invoker.run(useCases.checkDonationReturn, visitor, { token });
    amount = formatMoney(outcome.amount, outcome.currency, locale);
    checkout = outcome.checkoutUrl;
    interval = outcome.interval;
    membership = outcome.membership;
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
  const back = plainSitePath(url.searchParams.get('back'));
  return {
    state,
    amount,
    interval,
    membership,
    signinSent: url.searchParams.get('signin') === 'sent',
    backQuery: back ? `&back=${encodeURIComponent(back)}` : '',
    back: sitePath(site, back ?? '/'),
    again: back ? `${url.pathname}?back=${encodeURIComponent(back)}` : url.pathname,
    pay: url.searchParams.has('pay') && state === 'pending' ? checkout : null,
  };
}

/**
 * "Send me a sign-in link" on the return page of a paid membership (`donation.signin.request`):
 * the link goes to the address that paid, never to this page, and the answer is the same whether
 * anything was sent. After sign-in the reader lands on the page the form was on.
 */
export async function requestMemberSignin(
  site: Site,
  locale: string,
  token: string,
  url: URL
): Promise<string> {
  const visitor = anonymousPrincipal(siteTenant(site), ['donations:write']);
  const back = plainSitePath(url.searchParams.get('back'));
  try {
    await runtime().invoker.run(useCases.requestMemberSignin, visitor, {
      token,
      locale,
      ...(back ? { returnPath: back } : {}),
    });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') refuse(404);
    throw e;
  }
  const query = new URLSearchParams({ signin: 'sent', ...(back ? { back } : {}) });
  return `${url.pathname}?${query}`;
}
