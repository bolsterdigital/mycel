// The storage catalog entries of the writing assistant (ADR 021), spread into `STORAGE` in
// `../storage.ts`, which holds the rules of the catalog. Apart so that file stays under its size
// ceiling; the conformance suites read the merged `STORAGE`, so nothing is checked less.

import type { StorageEntry } from '../storage.js';

export const ASSIST_STORAGE = {
  assist_settings: {
    category: 'assist',
    owner: 'tenant',
    copies: [
      {
        field: 'consented_by',
        subject: 'operator',
        route: {
          kind: 'excluded',
          reason: 'who consented to a provider is the evidence of that consent (ADR 021)',
        },
      },
    ],
    retention: { kind: 'kept', why: 'part of the site while the tenant exists' },
  },
  assist_suggestions: {
    category: 'assist',
    owner: 'tenant',
    copies: [
      {
        field: 'value',
        subject: 'anyone',
        route: { kind: 'expires', why: 'a suggestion is a short-lived copy of editor text' },
      },
      {
        field: 'requested_by',
        subject: 'operator',
        route: { kind: 'expires', why: 'goes with the suggestion' },
      },
    ],
    retention: { kind: 'term', term: '30 days (ASSIST_RETENTION_DAYS)', by: 'assist.retention' },
  },
  assist_usage: {
    category: 'assist',
    owner: 'tenant',
    copies: [],
    retention: { kind: 'term', term: 'earlier months', by: 'assist.retention' },
  },
} as const satisfies Record<string, StorageEntry>;
