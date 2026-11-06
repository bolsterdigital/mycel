// The notifications page (brief admin-attention-notifications § 5): the list the
// layout already read (`attention.list`), and one action, "mark as read", which moves the member's
// `attention_seen_at` to the moment the page was shown. The page posts it by itself with
// JavaScript (static/_admin/attention-seen.js); without, it is a button. The moment comes from
// the form, so what arrived between showing and posting stays new; core caps it at now.
// Rejected: marking read in the load (a GET that writes, and an audit row per page view even with
// nothing new) and a moment from the server at post time (it would swallow what arrived since).
import { useCases } from '@mycel/core';
import { act, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  await parent();
  return { shownAt: new Date().toISOString() };
};

export const actions: Actions = {
  seen: (event) =>
    act(event, 'seen', { conflict: 'admin.error.invalid' }, async (principal, data) => {
      await runtime().invoker.run(useCases.updateAttentionSeenAt, principal, {
        at: text(data, 'at'),
      });
      return { action: 'seen', done: 'admin.attention.done.seen' as const };
    }),
};
