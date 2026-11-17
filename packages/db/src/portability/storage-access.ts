// The storage catalog entries of reader sign-in and the rate windows (ADR 016, ADR 019 rule 8),
// spread into `STORAGE` beside this file, which holds the rules of the catalog. Apart so that file
// stays under its size ceiling; the conformance suites read the merged `STORAGE`, so nothing is
// checked less.

import type { StorageEntry } from './storage.js';

export const ACCESS_STORAGE = {
  reader_signin_links: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'email',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'deletes the pending sign-in links of an erased address, with their mail intents',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: 'an hour after the link expires, which is 15 minutes after the request',
      by: 'rate_limits.sweep',
    },
  },
  reader_sessions: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes the reader sessions of an erased supporter' },
      },
    ],
    retention: {
      kind: 'term',
      term: 'an hour after the session ends, which is 12 hours after the sign-in',
      by: 'rate_limits.sweep',
    },
  },
  rate_limits: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'key',
        subject: 'supporter',
        route: { kind: 'expires', why: 'a keyed digest that lives a day at most (ADR 019 rule 8)' },
      },
    ],
    retention: { kind: 'term', term: '1 day', by: 'rate_limits.sweep' },
  },
  login_attempts: {
    category: 'access',
    owner: 'installation',
    copies: [
      {
        field: 'key',
        subject: 'visitor',
        route: { kind: 'expires', why: 'a login window key that lives a day at most' },
      },
    ],
    retention: { kind: 'term', term: '1 day', by: 'rate_limits.sweep' },
  },
} as const satisfies Record<string, StorageEntry>;
