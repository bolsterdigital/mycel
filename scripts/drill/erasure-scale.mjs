#!/usr/bin/env node
// Synthetic scale proof of the tenant-wide erasure apply: how much `apply` reads,
// how long it holds its locks and where it stops, measured instead of guessed. It seeds one new
// tenant with synthetic supporters, events, submissions, outbox events and jobs, registers a number
// of erasures, then times `applyErasures` (packages/db/src/erasures.ts) and prints the plan and
// buffers of each scan it makes, as mycel_erasure under the tenant's context, which is what apply
// runs as. `--registrations` past the lock table shows the ceiling: apply takes one advisory lock
// per registered address in one transaction.
//
//   source .scratch/<dir>/env.sh   # a scratch database: the tenant stays behind
//   node scripts/drill/erasure-scale.mjs --supporters 20000 --registrations 100
//
// Reads DATABASE_URL (the owner; apply needs it) and APP_DATABASE_URL. Prints one JSON report.
// Rows are inserted as mycel_app under the tenant's context with set-based SQL, not through the
// use cases: the proof is about the volume apply scans, and ingest at this volume takes hours.
// Rejected: a vitest suite (CI would pay minutes for a number nobody gates on) and production-like
// volumes in the docs (there is no production tenant; the numbers are this machine's).

import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { applyErasures, createDb, uuidv7 } from '@mycel/db';
import { testTenant } from '@mycel/db/testing';

const { values: opts } = parseArgs({
  options: {
    supporters: { type: 'string', default: '20000' },
    'events-per-supporter': { type: 'string', default: '2' },
    registrations: { type: 'string', default: '100' },
    jobs: { type: 'string', default: '2000' },
  },
});
const n = {
  supporters: Number(opts.supporters),
  eventsPer: Number(opts['events-per-supporter']),
  registrations: Number(opts.registrations),
  jobs: Number(opts.jobs),
};
if (n.registrations > n.supporters) throw new Error('--registrations exceeds --supporters');

const operatorDb = createDb(process.env.DATABASE_URL);
const appDb = createDb(process.env.APP_DATABASE_URL);

/** One transaction as `role` in the tenant's context. */
const inTenant = (db, role, tenantId, fn) =>
  db.transaction().execute(async (trx) => {
    await sql`select set_config('role', ${role}, true),
                     set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });

const ms = (start) => Math.round(performance.now() - start);
/** `Rows Removed by Filter` anywhere in a plan node and its children. */
const rowsRemoved = (node) =>
  (node['Rows Removed by Filter'] ?? 0) +
  (node.Plans ?? []).reduce((sum, child) => sum + rowsRemoved(child), 0);

try {
  const tenant = await testTenant(operatorDb, `erasure-scale-${Date.now().toString(36)}`);
  const t = tenant.id;
  const formId = uuidv7();
  const address = (i) => sql`'scale-' || ${sql.raw(i)} || '@example.org'`;

  const seedStart = performance.now();
  await inTenant(operatorDb, 'mycel_app', t, async (trx) => {
    await sql`insert into forms (id, tenant_id, definition)
              values (${formId}, ${t}, '{"fields":[]}'::jsonb)`.execute(trx);
    await sql`
      insert into supporters (tenant_id, id, email, first_seen, last_activity, lists,
                              applied_through_at, applied_through_id)
      select ${t}, gen_random_uuid(), ${address('g')}, now(), now(), array['news'], now(), 'scale'
      from generate_series(1, ${n.supporters}) g`.execute(trx);
    await sql`
      insert into events (tenant_id, id, supporter_id, schema, type, email, occurred_at, source,
                          source_site, source_ref, props, ingested_at)
      select ${t}, gen_random_uuid()::text, s.id, 'wings.supporter-event.v1', 'signup', s.email,
             now(), 'scale', 'scale', 'scale', jsonb_build_object('list', 'news'), now()
      from supporters s, generate_series(1, ${n.eventsPer})`.execute(trx);
    await sql`
      insert into form_submissions (id, tenant_id, form_id, values, locale, created_at, evaluation,
                                    list, consent_text_version)
      select gen_random_uuid(), ${t}, ${formId},
             jsonb_build_object('email', s.email, 'name', 'Scale ' || s.id), 'nl', now(), '{}'::jsonb,
             'news', 'v1'
      from supporters s`.execute(trx);
    await sql`
      insert into outbox (id, tenant_id, type, occurred_at, actor, props)
      select gen_random_uuid(), ${t}, 'form.submitted', now(),
             '{"kind":"anonymous","channel":"web"}'::jsonb, jsonb_build_object('email', s.email)
      from supporters s`.execute(trx);
    await sql`
      insert into jobs (id, tenant_id, type, key, run_at, payload)
      select gen_random_uuid(), ${t}, 'mail.reconcile', 'scale:' || ${t} || ':' || g, now() + interval '1 year',
             jsonb_build_object('eventId', gen_random_uuid())
      from generate_series(1, ${n.jobs}) g`.execute(trx);
    await sql`
      insert into erasures (tenant_id, supporter_id, email_hash, erased_at, actor)
      select ${t}, s.id, encode(sha256(convert_to(${t} || E'\n' || s.email, 'UTF8')), 'hex'), now(),
             '{"kind":"system","job":"erasure-scale"}'::jsonb
      from (select id, email from supporters order by email limit ${n.registrations}) s`.execute(
      trx
    );
  });
  const seedMs = ms(seedStart);

  const counts = await inTenant(operatorDb, 'mycel_app', t, async (trx) => {
    const { rows } = await sql`
      select (select count(*) from supporters)::int as supporters,
             (select count(*) from events)::int as events,
             (select count(*) from form_submissions)::int as submissions,
             (select count(*) from erasures)::int as registrations`.execute(trx);
    return rows[0];
  });

  // The scans apply makes, as it makes them (erasures.ts eraseRows): every row of the tenant.
  const scans = {
    supporters: sql`select id, email from supporters`,
    events: sql`select id, supporter_id, email from events`,
    form_submissions: sql`select id, values, evaluation from form_submissions`,
    outbox: sql`select id, type, props from outbox`,
    jobs: sql`select id, payload, type from jobs`,
  };
  const plans = {};
  for (const [name, query] of Object.entries(scans)) {
    plans[name] = await inTenant(operatorDb, 'mycel_erasure', t, async (trx) => {
      const { rows } = await sql`explain (analyze, buffers, format json) ${query}`.execute(trx);
      const plan = rows[0]['QUERY PLAN'][0];
      const top = plan.Plan;
      return {
        node: top['Node Type'] + (top['Index Name'] ? ` (${top['Index Name']})` : ''),
        rows: top['Actual Rows'],
        // Rows of other tenants the scan read and RLS dropped (no tenant index on the table).
        otherTenantsRows: rowsRemoved(top),
        bufferPages: (top['Shared Hit Blocks'] ?? 0) + (top['Shared Read Blocks'] ?? 0),
        ms: Math.round(plan['Execution Time']),
      };
    });
  }

  const { rows: settings } = await sql`
    select name, setting from pg_settings
    where name in ('max_locks_per_transaction', 'max_connections', 'max_prepared_transactions')
    order by name`.execute(operatorDb);

  const heap = { before: process.memoryUsage().rss, peak: 0 };
  const sampler = setInterval(() => {
    heap.peak = Math.max(heap.peak, process.memoryUsage().rss);
  }, 20);
  const applyStart = performance.now();
  let first;
  try {
    first = { changed: await applyErasures(operatorDb, t), ms: ms(applyStart) };
  } catch (e) {
    first = { error: e.message, ms: ms(applyStart) };
  }
  clearInterval(sampler);
  const secondStart = performance.now();
  const second = first.error
    ? null
    : { changed: await applyErasures(operatorDb, t), ms: ms(secondStart) };

  console.log(
    JSON.stringify(
      {
        tenant: tenant.slug,
        seeded: { ...counts, outbox: n.supporters, jobs: n.jobs, ms: seedMs },
        settings: Object.fromEntries(settings.map((s) => [s.name, Number(s.setting)])),
        advisoryLocksPerApply: counts.registrations,
        apply: first,
        repeatApply: second,
        rssMiB: {
          before: Math.round(heap.before / 2 ** 20),
          peak: Math.round(Math.max(heap.peak, process.memoryUsage().rss) / 2 ** 20),
        },
        scans: plans,
      },
      null,
      2
    )
  );
} finally {
  await operatorDb.destroy();
  await appDb.destroy();
}
