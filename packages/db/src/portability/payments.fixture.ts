// Seed one paid donation of a known supporter with its ledger (0072), for the suites that need a
// row in every tenant table: the RLS conformance, the portable archive round trip and the
// erasure fixture. Written as the use cases write it, without a provider. Rejected: a payment
// without a supporter, which would leave the erasure route of `supporter_id` unproven.
import { sql, type Kysely } from 'kysely';
import type { Principal } from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { asRole } from '../infra/roles.js';
import { uuidv7 } from '../infra/ids.js';

export async function seedPayment(operatorDb: Kysely<Database>, admin: Principal, email: string) {
  const id = uuidv7();
  await asRole(operatorDb, 'mycel_app', async (trx) => {
    await sql`select set_config('app.tenant_id', ${admin.tenantId}, true)`.execute(trx);
    await sql`insert into payments
      (id, tenant_id, kind, status, amount, currency, description, locale, provider, provider_ref,
       provider_status, supporter_id, created_at, updated_at, paid_at)
      select ${id}, ${admin.tenantId}, 'donation', 'paid', 2500, 'EUR', 'Donation', 'nl', 'fake',
             ${`fake_${id}`}, 'paid', id, now(), now(), now()
      from supporters where email = ${email}`.execute(trx);
    for (const [from, to] of [
      [null, 'created'],
      ['created', 'open'],
      ['open', 'paid'],
    ] as const)
      await sql`insert into ledger_entries
        (id, tenant_id, payment_id, from_status, to_status, cause, provider_status, amount,
         currency, at, actor)
        values (${uuidv7()}, ${admin.tenantId}, ${id}, ${from}, ${to}, 'checkout', ${to}, 2500,
                'EUR', now(), ${JSON.stringify({ kind: 'system', job: 'fixture' })}::jsonb)`.execute(
        trx
      );
  });
  return id;
}
