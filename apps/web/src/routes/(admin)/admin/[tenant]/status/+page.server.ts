// The status page of a site (TODO #17c, brief observability-c-recovery decisions 4 to 6): its
// stuck jobs, its mail with an uncertain outcome, the latest actions and the diagnosis to share,
// all from `ops.status`; per job "try again" and "close", native form posts through the same use
// cases HTTP and MCP expose. Closing asks first: without JavaScript there is no `confirm()`, so the
// first post answers with a confirmation and only a second post with `confirm=yes` closes.
// Rejected: a `confirm()` on the button (needs JavaScript, and a no-JS post would close at once)
// and a "send to support" button (it would send a text the administrator never read).
import { can, useCases } from '@mycel/core';
import { error } from '@sveltejs/kit';
import { act, text } from '#lib/server/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'tenant:admin')) error(403, 'tenant:admin');
  return { status: await runtime().invoker.run(useCases.getOpsStatus, principal, {}) };
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
      const id = text(data, 'id');
      if (text(data, 'confirm') !== 'yes')
        return { action: 'close', confirm: { id, type: text(data, 'type') } };
      await runtime().invoker.run(useCases.closeJob, principal, { id });
      return { action: 'close', done: 'admin.status.done.closed' as UiKey };
    }),
};
