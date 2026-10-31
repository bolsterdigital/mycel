// The status page of a site (TODO #17c, brief observability-c-recovery decisions 4 to 6, brief
// admin-operations-screens): the verdict, waiting and stuck work, mail with an uncertain outcome,
// the erasure requests, the latest actions and the diagnosis to share, all from one
// `ops.status.get`; per job "try again" and "close", native form posts through the same use cases
// HTTP and MCP expose. Closing is confirmed in the row (ConfirmAction, a disclosure that works
// without JavaScript) and only a post with `confirm=yes` closes; one without changes nothing.
// Rejected: a `confirm()` on the button (needs JavaScript, and a no-JS post would close at once)
// and a "send to support" button (it would send a text the administrator never read).
import { useCases } from '@mycel/core';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { statusSubnav } from '#lib/server/admin/status-nav.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { tenant, locale } = await parent();
  const principal = locals.principal!;
  return {
    subnav: statusSubnav(locale, `/admin/${tenant.slug}`, 'overview'),
    status: await loaded(runtime().invoker.run(useCases.getOpsStatus, principal, {})),
  };
};

const COPY = {
  conflict: 'admin.status.error.notExhausted',
  notFound: 'admin.status.error.notFound',
} as const;

export const actions: Actions = {
  retry: (event) =>
    act(event, 'retry', COPY, async (principal, data) => {
      await runtime().invoker.run(useCases.retryJob, principal, { id: text(data, 'id') });
      return { action: 'retry', done: 'admin.status.done.retried' as UiKey };
    }),
  close: (event) =>
    act(event, 'close', COPY, async (principal, data) => {
      if (text(data, 'confirm') !== 'yes') return { action: 'close' };
      await runtime().invoker.run(useCases.closeJob, principal, { id: text(data, 'id') });
      return { action: 'close', done: 'admin.status.done.closed' as UiKey };
    }),
};
