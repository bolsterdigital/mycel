// One monthly or yearly gift (`donation.subscription.get`, MY-254 PR 2): what is given, where it
// stands, its payments and its ledger, and one thing to change: "Stop" (`donation.subscription.
// cancel`), which charges nothing more. That use case holds the authorization
// (`donations:write`) and the tenant boundary; the load only decides whether to offer the button.
// An id that is no gift of this site is 404. The giver's address comes only with
// `supporters:read`, as on the list.
import { can, isUuid, useCases } from '@mycel/core';
import { act, loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'donations:read')) refuse(403);
  if (!isUuid(params.id)) refuse(404);
  const { subscription, ledger, payments, supporter } = await loaded(
    runtime().invoker.run(useCases.getSubscription, principal, { subscriptionId: params.id })
  );
  const live = ['pending', 'active', 'paused'].includes(subscription.status);
  return {
    subscription,
    ledger: ledger.toReversed(),
    payments,
    supporter,
    canStop: live && !subscription.cancelAtPeriodEnd && can(principal, 'donations:write'),
  };
};

export const actions: Actions = {
  stop: (event) =>
    act(
      event,
      'stop',
      { conflict: 'admin.giving.stop.failed', notFound: 'admin.giving.gone' },
      async (principal) => {
        await runtime().invoker.run(useCases.cancelSubscription, principal, {
          subscriptionId: event.params.id,
        });
        return { done: 'admin.giving.stop.done' as const };
      }
    ),
};
