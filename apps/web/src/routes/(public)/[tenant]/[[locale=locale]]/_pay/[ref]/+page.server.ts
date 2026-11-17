// The payment screen of the fake provider (`PAYMENT_PROVIDER=fake`, brief MY-252 PR 2): what a
// real provider's checkout is, on a trial installation and in the e2e gate. It shows the amount
// and three buttons, paid, failed and expired; a choice settles the payment in the provider's
// directory and sends the visitor to the return page the payment was opened with, which then
// asks the provider as it would ask Mollie. A 404 when the provider is not the fake one.
//
// The directory is the provider's, not a tenant's: any site of the installation shows any fake
// payment. That is what a provider's checkout does too, and money never moves here.

import { fail, redirect } from '@sveltejs/kit';
import { FAKE_CHOICES, type FakeChoice } from '@mycel/api/compose';
import { formatMoney } from '#lib/money.js';
import { localeOf } from '#lib/server/public/content-route.js';
import { NO_STORE } from '#lib/server/http/http-cache.js';
import { refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

function provider() {
  const fake = runtime().fakePayments;
  if (!fake) refuse(404);
  return fake;
}

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
  const locale = localeOf(params.locale, requireSite(locals).tenant);
  if (!locale) refuse(404);
  locals.lang = locale;
  const payment = provider().read(params.ref);
  if (!payment) refuse(404);
  setHeaders({ 'cache-control': NO_STORE, 'x-robots-tag': 'noindex' });
  return {
    locale,
    open: payment.outcome === 'open',
    description: payment.description,
    amount: formatMoney(payment.amount, payment.currency, locale),
    choices: FAKE_CHOICES,
  };
};

export const actions: Actions = {
  default: async ({ params, request }) => {
    const choice = (await request.formData()).get('outcome');
    if (!FAKE_CHOICES.includes(choice as FakeChoice)) return fail(400);
    const payment = provider().settle(params.ref, choice as FakeChoice);
    if (!payment) refuse(404);
    redirect(303, payment.returnUrl);
  },
};
