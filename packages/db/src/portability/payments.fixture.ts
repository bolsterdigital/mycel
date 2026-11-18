// Seed one paid donation of a known supporter with its ledger (0072), and a monthly gift of the
// same supporter with its mandate, first payment, one charge attempt and its own ledger entry
// (0077), for the suites that need a row in every tenant table: the RLS conformance, the portable
// archive round trip and the erasure fixture. Written as the use cases write it, without a
// provider. Rejected: a payment without a supporter, which would leave the erasure route of
// `supporter_id` unproven.
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
    for (const [seq, from, to] of [
      [1, null, 'created'],
      [2, 'created', 'open'],
      [3, 'open', 'paid'],
    ] as const)
      await sql`insert into ledger_entries
        (id, tenant_id, payment_id, seq, from_status, to_status, cause, provider_status, amount,
         currency, at, actor)
        values (${uuidv7()}, ${admin.tenantId}, ${id}, ${seq}, ${from}, ${to}, 'checkout', ${to},
                2500, 'EUR', now(), ${JSON.stringify({ kind: 'system', job: 'fixture' })}::jsonb)`.execute(
        trx
      );
    const [mandate, subscription, first] = [uuidv7(), uuidv7(), uuidv7()];
    const actor = JSON.stringify({ kind: 'system', job: 'fixture' });
    await sql`insert into mandates
      (id, tenant_id, provider, customer_ref, mandate_ref, status, method, supporter_id,
       created_at, updated_at)
      select ${mandate}, ${admin.tenantId}, 'fake', 'cst_fixture', 'mdt_fixture', 'valid',
             'directdebit', id, now(), now()
      from supporters where email = ${email}`.execute(trx);
    await sql`insert into subscriptions
      (id, tenant_id, kind, status, amount, currency, interval, description, locale, provider,
       supporter_id, mandate_id, started_at, periods_paid, paid_through, next_charge_at,
       created_at, updated_at)
      select ${subscription}, ${admin.tenantId}, 'donation', 'active', 1000, 'EUR', 'month',
             'Monthly gift', 'nl', 'fake', id, ${mandate}, now(), 1, now() + interval '1 month',
             now() + interval '1 month', now(), now()
      from supporters where email = ${email}`.execute(trx);
    await sql`insert into payments
      (id, tenant_id, kind, status, amount, currency, description, locale, provider, provider_ref,
       provider_status, supporter_id, subscription_id, sequence, created_at, updated_at, paid_at)
      select ${first}, ${admin.tenantId}, 'donation', 'paid', 1000, 'EUR', 'Monthly gift', 'nl',
             'fake', ${`fake_${first}`}, 'paid', id, ${subscription}, 'first', now(), now(), now()
      from supporters where email = ${email}`.execute(trx);
    await sql`insert into charge_attempts
      (tenant_id, key, subscription_id, payment_id, status, created_at, updated_at)
      values (${admin.tenantId}, ${`subscription:${subscription}:fixture:1`}, ${subscription},
              ${uuidv7()}, 'done', now(), now())`.execute(trx);
    await sql`insert into ledger_entries
      (id, tenant_id, subscription_id, seq, from_status, to_status, step, cause, provider_status,
       paid_through, failed_attempts, amount, currency, at, actor)
      values (${uuidv7()}, ${admin.tenantId}, ${subscription}, 1, null, 'active', 'activated',
              'webhook', '', now() + interval '1 month', 0, 1000, 'EUR', now(),
              ${actor}::jsonb)`.execute(trx);
  });
  return id;
}
