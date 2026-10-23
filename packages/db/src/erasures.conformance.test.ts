// Erasure conformance against Postgres (TODO #18d, migration 0019; ADR 003 rule 5, ADR 019 rule
// 8): after `register` plus `apply` the address is in no row of the tenant, the event count holds,
// a second apply changes nothing, the other tenant keeps the same address, and the register is
// permanent and invisible to the roles that have no business with it. The fixture goes through the
// real paths: a signup (submission, outbox event), ingest (events, projection) and the
// confirmation mail (intent row, reconcile job), with the subscribers fed the outbox's own events.
// packages/core/src/supporters/erasure.test.ts holds the memory adapter to the same contract.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  confirmationMailSubscriber,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
  type UnitOfWork,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryMailer,
  memoryPlatform,
  probeForm,
} from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  migrate,
  readOutboxEvent,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

describe.skipIf(!operatorUrl || !appUrl)('erasure conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const email = `erase-me-${run}@example.org`;
  const other = `keep-me-${run}@example.org`;
  const clock = { now: () => new Date() };
  const signer = new FakeSigner();
  const deps = {
    clock,
    ids: uuidv7Ids,
    signer,
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  };
  const uow = createUnitOfWork(appDb, deps);
  const invoker = new Invoker(buildRegistry(), uow);
  const tenants: Record<'a' | 'b', string> = { a: '', b: '' };
  let supporterId = '';

  /** Every row of the tenant, as text, from every table that has a tenant_id (the catalog). */
  async function rowsOf(tenantId: string): Promise<Record<string, string[]>> {
    const tables = (
      await sql<{ name: string }>`
        select c.relname as name from pg_class c join pg_attribute a on a.attrelid = c.oid
        where a.attname = 'tenant_id' and not a.attisdropped and c.relkind in ('r', 'p')
          and c.relnamespace = 'public'::regnamespace and not c.relispartition
        order by 1`.execute(operatorDb)
    ).rows.map((r) => r.name);
    const out: Record<string, string[]> = {};
    for (const table of tables) {
      // The outbox and the jobs payload are the worker's to read; everything else mycel_app's.
      const role = table === 'outbox' || table === 'jobs' ? 'mycel_worker' : 'mycel_app';
      out[table] = await operatorDb.transaction().execute(async (trx) => {
        await sql`select set_config('role', ${role}, true),
                         set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        const { rows } = await sql<{ row: string }>`
          select t::text as row from ${sql.table(table)} t where t.tenant_id = ${tenantId}`.execute(
          trx
        );
        return rows.map((r) => r.row);
      });
    }
    return out;
  }
  const holding = (rows: Record<string, string[]>, address: string) =>
    Object.entries(rows)
      .filter(([, list]) => list.some((r) => r.toLowerCase().includes(address)))
      .map(([table]) => table);
  const eventCount = async (tenantId: string) => (await rowsOf(tenantId))['events']!.length;

  /** A signup, its ingest and its confirmation mail, through the outbox's own events. */
  async function signup(tenantId: string, address: string, mailUow: UnitOfWork) {
    const admin = systemPrincipal(tenantId, 'erasure-test');
    const formId = uuidv7();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
    const submitted = await invoker.run(useCases.submitForm, admin, {
      formId,
      values: { email: address, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(`signup ${submitted.status}`);
    const ids = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return (
        await sql<{ id: string }>`select id from outbox where tenant_id = ${tenantId}`.execute(trx)
      ).rows;
    });
    for (const { id } of ids) {
      const event = (await readOutboxEvent(operatorDb, id))!;
      if (event.type !== 'newsletter.subscribed') continue;
      await supporterIngestSubscriber(uow).handle(event);
      await confirmationMailSubscriber({
        mailer: new MemoryMailer(),
        signer,
        clock,
        tenants: createTenantDirectory(appDb),
        uow: mailUow,
        from: { email: 'noreply@example.org' },
        platform: memoryPlatform,
      }).handle(event);
    }
  }

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      appPassword: process.env['MYCEL_APP_PASSWORD'],
      authPassword: process.env['MYCEL_AUTH_PASSWORD'],
      log: () => {},
    });
    for (const key of ['a', 'b'] as const)
      tenants[key] = (
        await upsertTenant(
          operatorDb,
          {
            id: uuidv7(),
            slug: `erase-${key}-${run}`,
            name: `Erase ${key}`,
            defaultLocale: 'nl',
            locales: ['nl'],
          },
          { platformDomain: 'localhost' }
        )
      ).id;
    await signup(tenants.a, email, uow);
    await signup(tenants.a, other, uow);
    // Tenant B has a supporter with the very same address: an erasure is one tenant's business.
    await signup(tenants.b, email, uow);
    supporterId = (await uow.run(systemPrincipal(tenants.a, 'erasure-test'), (ctx) =>
      ctx.supporters.getProjection(email)
    ))!.id;
  });

  afterAll(async () => {
    // The confirmations planned `mail.reconcile` jobs; close what apply left so a worker on the
    // same database never runs them (TODO #26).
    await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      await sql`update jobs set done_at = now() where done_at is null
                and tenant_id in (${tenants.a}, ${tenants.b})`.execute(trx);
    });
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('starts with the address in every kind of copy', async () => {
    expect(holding(await rowsOf(tenants.a), email)).toEqual(
      expect.arrayContaining(['events', 'supporters', 'form_submissions', 'outbox'])
    );
    // The intent row and its job carry ids, not the address: apply finds them by the event.
    const rows = await rowsOf(tenants.a);
    expect(rows['mail_sends']!.length).toBeGreaterThanOrEqual(2);
    expect(rows['jobs']!.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to apply on the fronts login', async () => {
    const admin = systemPrincipal(tenants.a, 'erasure-test');
    await expect(uow.run(admin, (ctx) => ctx.erasures.apply())).rejects.toThrow(
      /operator connection/
    );
  });

  it('removes the address from every row of the tenant and keeps the event count', async () => {
    const admin = systemPrincipal(tenants.a, 'erasure-test');
    const before = await rowsOf(tenants.a);
    await uow.run(admin, (ctx) => ctx.erasures.register(supporterId, email.toUpperCase()));
    // The register holds no address, only its hash, from the first moment.
    expect(holding(await rowsOf(tenants.a), email)).not.toContain('erasures');

    const changed = await applyErasures(operatorDb, tenants.a);
    expect(changed).toBeGreaterThan(0);
    const after = await rowsOf(tenants.a);
    expect(holding(after, email)).toEqual([]);
    expect(after['events']!.length).toBe(before['events']!.length);
    expect(after['events']!.some((r) => r.includes(`${supporterId}@erased.invalid`))).toBe(true);
    // The intents and reconcile jobs of the erased signup went; the other supporter's stayed.
    expect(after['mail_sends']!.length).toBe(before['mail_sends']!.length - 1);
    expect(holding(after, other)).toEqual(
      expect.arrayContaining(['events', 'supporters', 'form_submissions', 'outbox'])
    );
    expect(after['audit_log']!.length).toBeGreaterThanOrEqual(before['audit_log']!.length);
  });

  it('is idempotent: a second apply changes nothing', async () => {
    expect(await applyErasures(operatorDb, tenants.a)).toBe(0);
  });

  it('leaves the same address in another tenant alone', async () => {
    expect(holding(await rowsOf(tenants.b), email)).toEqual(
      expect.arrayContaining(['events', 'supporters', 'form_submissions', 'outbox'])
    );
    expect(await eventCount(tenants.b)).toBeGreaterThan(0);
  });

  it('erases again what a restore brings back, from the register alone', async () => {
    // A restore of an older backup puts the person back; the register of the newer one stays.
    // Simulated with a second supporter of tenant A erased while its rows are still there.
    const admin = systemPrincipal(tenants.a, 'erasure-test');
    const late = (await uow.run(admin, (ctx) => ctx.supporters.getProjection(other)))!;
    await uow.run(admin, (ctx) => ctx.erasures.register(late.id, other));
    expect(await applyErasures(operatorDb, tenants.a)).toBeGreaterThan(0);
    expect(holding(await rowsOf(tenants.a), other)).toEqual([]);
  });

  it('keeps registrations permanent: mycel_app cannot change or remove them', async () => {
    const attempt = (statement: ReturnType<typeof sql>) =>
      appDb.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenants.a}, true)`.execute(trx);
        await statement.execute(trx);
      });
    await expect(attempt(sql`update erasures set email_hash = ${'0'.repeat(64)}`)).rejects.toThrow(
      /permission denied/
    );
    await expect(attempt(sql`delete from erasures`)).rejects.toThrow(/permission denied/);
  });

  it('is invisible to mycel_auth and mycel_platform', async () => {
    const { rows } = await sql<{ role: string; granted: boolean }>`
      select r as role, has_table_privilege(r, 'public.erasures', 'select') as granted
      from unnest(array['mycel_auth', 'mycel_platform', 'mycel_ops', 'mycel_worker']) r`.execute(
      operatorDb
    );
    expect(rows.filter((r) => r.granted)).toEqual([]);
  });
});
