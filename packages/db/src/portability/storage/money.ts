// The storage catalog entries of the money ledger (ADR 005, migrations 0072 and 0077): payments,
// subscriptions, mandates, charge attempts and the one ledger they share. Spread into `STORAGE`
// in `../storage.ts`, which holds the rules of the catalog; apart so that file stays under its
// size ceiling. The conformance suites read the merged `STORAGE`, so nothing is checked less.

import type { Copy, StorageEntry } from '../storage.js';

const BOOKS = {
  kind: 'kept',
  why: 'the organisation’s record of what it received (ADR 005 rule 1); bookkeeping law sets the term, not Mycel',
} as const;

/** As `ACTOR` in `../storage.ts`, which this file cannot import (that file imports this one). */
const ACTOR: Copy = {
  field: 'actor',
  subject: 'operator',
  route: {
    kind: 'excluded',
    reason:
      'kind and operator id only, never an address (ADR 035 rule 4); the id is attribution (ADR 009 rule 9)',
  },
};

const DESCRIPTION: Copy = {
  field: 'description',
  subject: 'anyone',
  route: {
    kind: 'excluded',
    reason:
      'the line the site gives a payment for the provider and the statement, fixed at creation; the use case forbids an address or a name in it and no supporter field is copied into it',
  },
};

export const MONEY_STORAGE = {
  payments: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'clears the supporter id; the amount, status and ledger stay with nobody attached',
        },
      },
      DESCRIPTION,
    ],
    retention: BOOKS,
  },
  ledger_entries: {
    category: 'supporters',
    owner: 'tenant',
    copies: [ACTOR],
    retention: {
      kind: 'kept',
      why: 'append-only history of a payment or a subscription (ADR 005 rule 1); apply only appends the step that ends an erased donor’s subscription',
    },
  },
  subscriptions: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'ends a live subscription (reason erasure, one ledger entry, no next charge) and clears the supporter id; amounts and ledger stay',
        },
      },
      DESCRIPTION,
    ],
    retention: BOOKS,
  },
  mandates: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'marks the mandate invalid, so nothing charges it, and clears the supporter id',
        },
      },
      {
        field: 'customer_ref',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'the provider’s reference for its customer, no address or name; the customer record itself is a provider copy with its own owner (ADR 024)',
        },
      },
    ],
    retention: BOOKS,
  },
  charge_attempts: {
    category: 'supporters',
    owner: 'tenant',
    // Key, subscription and payment ids: no person.
    copies: [],
    retention: {
      kind: 'kept',
      why: 'the intent row of a charge (ADR 019 rule 6), kept with the payment it became',
    },
  },
} as const satisfies Record<string, StorageEntry>;
