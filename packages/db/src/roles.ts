// The one place that switches a transaction's role and takes an advisory lock (TODO #53). A role
// switch is the route around RLS, so every switch names a role from the closed list below, and
// `scripts/db-roles.test.mjs` keeps every form of role switch and advisory lock out of every
// other file. Rejected: a helper per module (`asWorker`, `asAuth`, `asOps`, `asPlatform`), which
// is how the pattern ended up written by hand seventeen times with no way to see them all.

import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

/** The roles a transaction may switch to; each one is defined, with its grants, in a migration. */
export type DbRole =
  | 'mycel_app'
  | 'mycel_auth'
  | 'mycel_audit_janitor'
  | 'mycel_erasure'
  | 'mycel_janitor'
  | 'mycel_ops'
  | 'mycel_platform'
  | 'mycel_worker';

/**
 * Switch the current transaction to `role`. `set local` ends with the transaction, and a failed
 * statement rolls back role and all, so there is no `reset role`.
 */
export async function setRole(trx: Trx, role: DbRole): Promise<void> {
  await sql`set local role ${sql.id(role)}`.execute(trx);
}

/**
 * Enter `tenantId`'s context as mycel_app (ADR 002): role and `app.tenant_id` in one statement,
 * both transaction-local, so a pooled connection never carries one tenant into another's request.
 */
export async function enterTenant(trx: Trx, tenantId: string): Promise<void> {
  await sql`select set_config('role', 'mycel_app', true),
                   set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
}

/** One transaction on `db` as `role`. */
export function asRole<T>(
  db: Kysely<Database>,
  role: DbRole,
  fn: (trx: Trx) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setRole(trx, role);
    return fn(trx);
  });
}

/** What an advisory lock serialises; the scope keeps two kinds of lock on one id apart. */
export type LockScope = 'admissions' | 'assist' | 'media' | 'members' | 'rate' | 'supporter';

/**
 * A transaction-scoped advisory lock on `scope` plus `parts`, keyed `scope:part:part` through
 * `hashtextextended(…, 0)`. Two transactions with the same key wait for each other until commit.
 */
export async function advisoryLock(trx: Trx, scope: LockScope, ...parts: string[]): Promise<void> {
  const key = [scope, ...parts].join(':');
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}
