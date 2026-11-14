// The storage catalog entries of site navigation (ADR 036, migration 0056), spread into
// `STORAGE` beside this file, which holds the rules of the catalog. Apart so that file stays under
// its size ceiling; the conformance suites read the merged `STORAGE`, so nothing is checked less.

import type { StorageEntry } from './storage.js';

const KEPT = { kind: 'kept', why: 'part of the site while the tenant exists' } as const;

export const NAVIGATION_STORAGE = {
  site_navigation: {
    category: 'site',
    owner: 'tenant',
    copies: [],
    retention: KEPT,
  },
  site_navigation_revisions: {
    category: 'site',
    owner: 'tenant',
    copies: [
      // Menu names and labels an editor typed; no actor is stored (0056), the audit log has it.
      {
        field: 'document',
        subject: 'anyone',
        route: {
          kind: 'excluded',
          reason:
            'navigation revisions are immutable history (ADR 036 rule 7); a new revision changes the current text',
        },
      },
    ],
    retention: { kind: 'kept', why: 'immutable history (ADR 036 rule 7)' },
  },
  site_navigation_locales: {
    category: 'site',
    owner: 'tenant',
    copies: [],
    retention: KEPT,
  },
  site_navigation_refs: {
    category: 'site',
    owner: 'tenant',
    copies: [],
    retention: { kind: 'kept', why: 'derived from an immutable revision, kept with it' },
  },
} as const satisfies Record<string, StorageEntry>;
