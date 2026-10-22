// Ports of the audit log. `AuditLog` is tenant data in the unit of work like any repository, so a
// successful command's row commits or rolls back with the command. `InputHasher` owns the key of
// the input hash (AUDIT_HASH_KEY), like the `Signer` owns the signing secret: the core decides
// what is hashed, the adapter holds the key and the MAC.

import type { AuditActorKind, AuditEntry } from './model.js';

export interface InputHasher {
  /** Lowercase hex HMAC-SHA256 of `canonical` under the audit key. */
  hash(canonical: string): Promise<string>;
}

export interface AuditListQuery {
  from?: Date | undefined;
  to?: Date | undefined;
  operation?: string | undefined;
  actorKind?: AuditActorKind | undefined;
  actorId?: string | undefined;
  /** Only rows whose result is not `ok`: refusals and failures (the #17c diagnosis). */
  failed?: boolean | undefined;
  /** The id of the last row of the previous page; newest first, by `(occurred_at, id)`. */
  cursor?: string | undefined;
  limit: number;
}

export interface AuditLog {
  /** Append one row to this tenant's log; there is no update and no delete. */
  record(entry: AuditEntry): Promise<void>;
  list(query: AuditListQuery): Promise<AuditEntry[]>;
}

declare module '../ports.js' {
  interface TransactionContext {
    audit: AuditLog;
    inputHasher: InputHasher;
  }
}
