// Postgres adapter (ADR 002). The only way to touch tenant data is `withTenant`, which opens a
// transaction, sets `app.tenant_id` for its duration, and hands the use case a Kysely instance.
// Kysely over an ORM: typed SQL without a second schema language, and RLS needs real SQL anyway.

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Principal } from '@mycel/core';

export interface Database {
  tenants: {
    id: string;
    slug: string;
    name: string;
    default_locale: string;
    locales: string[];
    created_at: Date;
  };
}

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}

/** Run `fn` inside a transaction scoped to the principal's tenant. */
export async function withTenant<T>(
  db: Kysely<Database>,
  principal: Principal,
  fn: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // `true` = transaction-local: the setting disappears at commit/rollback, so a pooled
    // connection can never carry one tenant's context into another's request.
    await sql`select set_config('app.tenant_id', ${principal.tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}
