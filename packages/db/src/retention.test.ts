// Retention against Postgres (migration 0048, docs/reference/jobs.md § Retention). Core proves the
// arithmetic of the terms; this suite proves what only the database can: the row just before a
// cut-off goes and the row on it stays, a row an open effect still needs stays whatever its age,
// a mail intent goes with its event and never alone, another tenant is not touched, batches add
// up and a second run finds nothing, the policies hold their floors under a wrong cut-off, and
// the fronts' login cannot enter the role.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  ADMISSION_WINDOW_MS,
  DEFAULT_RETENTION,
  monthsBefore,
  retentionCutoffs,
  systemPrincipal,
} from '@mycel/core';
import { runSuffix } from '@mycel/core/testing';
import { applyRetention, createDb, STORAGE, uuidv7, withTenant } from './index.js';
import type { Database } from './infra/schema.js';
import { asRole, setRole } from './infra/roles.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(skip)('retention', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const now = new Date();
  const cutoffs = retentionCutoffs(now, DEFAULT_RETENTION);
  const ms = (at: Date, delta: number) => new Date(at.getTime() + delta);
  let a = '';
  let b = '';
  const forms: Record<string, string> = {};

  const inTenant = <T>(tenantId: string, fn: (trx: Kysely<Database>) => Promise<T>) =>
    withTenant(operatorDb, systemPrincipal(tenantId, 'test'), fn);

  /** A processed (or, with `null`, unprocessed) outbox event; returns its id. */
  async function event(tenantId: string, processedAt: Date | null, props: object = {}) {
    const id = uuidv7();
    await inTenant(tenantId, (trx) =>
      sql`insert into outbox (id, tenant_id, type, occurred_at, actor, props, processed_at)
          values (${id}, ${tenantId}, 'test.retention', ${now}, '{"kind":"system","job":"test"}',
                  ${JSON.stringify(props)}, ${processedAt})`.execute(trx)
    );
    return id;
  }
  async function intent(tenantId: string, eventId: string) {
    await inTenant(tenantId, (trx) =>
      sql`insert into mail_sends (tenant_id, key, subscriber, event_id, attempted_at)
          values (${tenantId}, ${`test-${run}:${eventId}`}, ${`test-${run}`}, ${eventId}, ${now})`.execute(
        trx
      )
    );
  }
  /** An open `mail.reconcile` job naming `eventId`; returns the job id. */
  async function reconcileJob(tenantId: string, eventId: string) {
    const id = uuidv7();
    const key = `test-${run}:${eventId}`;
    await inTenant(tenantId, (trx) =>
      sql`insert into jobs (id, tenant_id, type, key, run_at, payload)
          values (${id}, ${tenantId}, 'mail.reconcile', ${`mail.reconcile:${key}`},
                  ${ms(now, 365 * DAY)},
                  ${JSON.stringify({ key, subscriber: `test-${run}`, eventId })})`.execute(trx)
    );
    return id;
  }
  const finishJob = (id: string) =>
    asRole(operatorDb, 'mycel_worker', (trx) =>
      sql`update jobs set done_at = now() where id = ${id}`.execute(trx)
    );
  async function submission(tenantId: string, createdAt: Date, businessId?: string) {
    const id = uuidv7();
    const evaluation = businessId ? JSON.stringify({ feedActions: [{ businessId }] }) : null;
    await inTenant(tenantId, (trx) =>
      sql`insert into form_submissions
            (id, tenant_id, form_id, "values", locale, created_at, list, consent_text_version,
             evaluation)
          values (${id}, ${tenantId}, ${forms[tenantId]}, '{"email":"ada@example.org"}', 'nl',
                  ${createdAt}, 'newsletter', 'v1', ${evaluation}::jsonb)`.execute(trx)
    );
    return id;
  }
  /** A connection with one intent in `state`; returns the intent's business id. */
  async function connectionIntent(tenantId: string, state: string) {
    const connectionId = uuidv7();
    const businessId = uuidv7();
    const intentId = uuidv7();
    await inTenant(tenantId, async (trx) => {
      await sql`insert into connections
          (id, tenant_id, provider, external_owner, maintainer, purpose, direction, data_authority,
           consent_authority, consent_scopes, form_ids, contract_version, adapter_version, state,
           version, credential_version, created_at, updated_at)
        values (${connectionId}, ${tenantId}, 'webhook', 'o', 'm', 'p', 'outbound', 'mycel',
                'mycel', '[]', '{}', '1', '1', 'active', 1, 1, ${now}, ${now})`.execute(trx);
      await sql`insert into connection_intents
          (id, tenant_id, connection_id, business_id, connection_version, credential_version,
           source, mapping_version, scope, actor, key, state, attempts, revision, next_at,
           created_at, updated_at)
        values (${intentId}, ${tenantId}, ${connectionId}, ${businessId}, 1, 1, 'test', '1',
                'newsletter', '{"kind":"system","job":"test"}', ${`test-${run}:${intentId}`},
                ${state}, 0, 0, ${now}, ${now}, ${now})`.execute(trx);
    });
    return { businessId, intentId };
  }
  async function seat(tenantId: string, admittedAt: Date) {
    const hash = uuidv7().replaceAll('-', '').padEnd(64, '0');
    await inTenant(tenantId, (trx) =>
      sql`insert into supporter_admissions (tenant_id, email_hash, admitted_at)
          values (${tenantId}, ${hash}, ${admittedAt})`.execute(trx)
    );
    return hash;
  }
  /** Which of `ids` still exist in `table`, read as the worker or under the tenant. */
  async function left(table: 'outbox' | 'form_submissions', tenantId: string, ids: string[]) {
    const { rows } = await inTenant(tenantId, async (trx) => {
      await setRole(trx, 'mycel_retention');
      return sql<{ id: string }>`
        select id from ${sql.table(table)} where id = any(${ids}::uuid[])`.execute(trx);
    });
    return ids.filter((id) => rows.some((r) => r.id === id));
  }
  const intentsOf = async (tenantId: string, eventId: string) =>
    (
      await inTenant(tenantId, (trx) =>
        sql`select 1 from mail_sends where event_id = ${eventId}`.execute(trx)
      )
    ).rows.length;

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    a = (await testTenant(operatorDb, `retention-a-${run}`)).id;
    b = (await testTenant(operatorDb, `retention-b-${run}`)).id;
    for (const tenantId of [a, b]) {
      forms[tenantId] = uuidv7();
      await inTenant(tenantId, (trx) =>
        sql`insert into forms (id, tenant_id, definition)
            values (${forms[tenantId]}, ${tenantId}, '{}')`.execute(trx)
      );
    }
  });
  afterAll(async () => {
    await closeTenantWork(operatorDb, [a, b]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('deletes a processed event just past 30 days with its mail intent, and keeps the one on the boundary', async () => {
    const past = await event(a, ms(cutoffs.outboxBefore, -1));
    const on = await event(a, cutoffs.outboxBefore);
    const young = await event(a, ms(cutoffs.outboxBefore, DAY));
    const pending = await event(a, null);
    const other = await event(b, ms(cutoffs.outboxBefore, -DAY));
    for (const [t, id] of [
      [a, past],
      [a, on],
      [b, other],
    ] as const)
      await intent(t, id);

    const gone = await applyRetention(operatorDb, a, cutoffs);
    expect(gone).toMatchObject({ outbox: 1, mailIntents: 1 });
    expect(await left('outbox', a, [past, on, young, pending])).toEqual([on, young, pending]);
    expect(await intentsOf(a, past)).toBe(0);
    expect(await intentsOf(a, on)).toBe(1);
    // The other tenant's event is as old and stays until its own run.
    expect(await left('outbox', b, [other])).toEqual([other]);
    expect(await intentsOf(b, other)).toBe(1);
    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({
      outbox: 0,
      mailIntents: 0,
    });
  });

  it('keeps an old event while an open reconcile job reads it, and deletes it once the job is done', async () => {
    const old = ms(cutoffs.outboxBefore, -10 * DAY);
    const needed = await event(a, old);
    await intent(a, needed);
    const job = await reconcileJob(a, needed);

    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({ outbox: 0 });
    expect(await left('outbox', a, [needed])).toEqual([needed]);
    expect(await intentsOf(a, needed)).toBe(1);

    await finishJob(job);
    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({
      outbox: 1,
      mailIntents: 1,
    });
    expect(await left('outbox', a, [needed])).toEqual([]);
  });

  it('deletes a submission just past the tenant term and keeps the one on the boundary', async () => {
    const past = await submission(a, ms(cutoffs.submissionsBefore, -1));
    const on = await submission(a, cutoffs.submissionsBefore);
    const young = await submission(a, ms(now, -40 * DAY));
    const other = await submission(b, ms(cutoffs.submissionsBefore, -DAY));

    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({ submissions: 1 });
    expect(await left('form_submissions', a, [past, on, young])).toEqual([on, young]);
    expect(await left('form_submissions', b, [other])).toEqual([other]);

    // A lower term for this tenant reaches the forty-day-old one too; the other tenant keeps its own.
    const lower = retentionCutoffs(now, { submissionMonths: 1 });
    expect(lower.submissionsBefore).toEqual(monthsBefore(now, 1));
    expect(await applyRetention(operatorDb, a, lower)).toMatchObject({ submissions: 2 });
    expect(await left('form_submissions', a, [on, young])).toEqual([]);
    expect(await left('form_submissions', b, [other])).toEqual([other]);
    expect(await applyRetention(operatorDb, b, cutoffs)).toMatchObject({ submissions: 1 });
  });

  it('keeps an old submission while an open effect still needs it', async () => {
    const old = ms(cutoffs.submissionsBefore, -DAY);
    const oldProcessed = ms(cutoffs.outboxBefore, -DAY);
    const undelivered = await submission(a, old);
    const deadEvent = await event(a, null, { submissionId: undelivered });
    const uncertain = await submission(a, old);
    const mailEvent = await event(a, oldProcessed, { submissionId: uncertain });
    const job = await reconcileJob(a, mailEvent);
    const open = await connectionIntent(a, 'unknown');
    const feeding = await submission(a, old, open.businessId);
    const settled = await connectionIntent(a, 'succeeded');
    const fed = await submission(a, old, settled.businessId);

    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({ submissions: 1 });
    expect(await left('form_submissions', a, [undelivered, uncertain, feeding, fed])).toEqual([
      undelivered,
      uncertain,
      feeding,
    ]);

    // Each one goes as soon as what needed it has settled.
    await asRole(operatorDb, 'mycel_worker', (trx) =>
      sql`update outbox set processed_at = ${oldProcessed} where id = ${deadEvent}`.execute(trx)
    );
    await finishJob(job);
    await inTenant(a, (trx) =>
      sql`update connection_intents set state = 'succeeded' where id = ${open.intentId}`.execute(
        trx
      )
    );
    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({
      submissions: 3,
      outbox: 2,
    });
    expect(await left('form_submissions', a, [undelivered, uncertain, feeding])).toEqual([]);
  });

  it('works through a backlog in batches and finds nothing the second time', async () => {
    const old = ms(cutoffs.submissionsBefore, -DAY);
    const subs = [];
    const events = [];
    for (let i = 0; i < 5; i++) {
      subs.push(await submission(a, old));
      events.push(await event(a, ms(cutoffs.outboxBefore, -DAY)));
    }
    expect(await applyRetention(operatorDb, a, cutoffs, 2)).toMatchObject({
      outbox: 5,
      submissions: 5,
    });
    expect(await left('form_submissions', a, subs)).toEqual([]);
    expect(await left('outbox', a, events)).toEqual([]);
    expect(await applyRetention(operatorDb, a, cutoffs, 2)).toEqual({
      outbox: 0,
      mailIntents: 0,
      submissions: 0,
      admissions: 0,
    });
  });

  it('deletes an admission seat past its window and keeps one inside it', async () => {
    const expired = await seat(a, ms(now, -ADMISSION_WINDOW_MS - 1));
    const live = await seat(a, ms(now, -ADMISSION_WINDOW_MS + DAY));
    const other = await seat(b, ms(now, -ADMISSION_WINDOW_MS - DAY));
    expect(await applyRetention(operatorDb, a, cutoffs)).toMatchObject({ admissions: 1 });
    const hashes = async (tenantId: string) =>
      (
        await inTenant(tenantId, (trx) =>
          sql<{ email_hash: string }>`select email_hash from supporter_admissions`.execute(trx)
        )
      ).rows.map((r) => r.email_hash);
    expect(await hashes(a)).toContain(live);
    expect(await hashes(a)).not.toContain(expired);
    expect(await hashes(b)).toContain(other);
  });

  it('holds its floors under a wrong cut-off', async () => {
    const fresh = await submission(a, ms(now, -5 * DAY));
    const pending = await event(a, null);
    const processed = await event(a, ms(now, -DAY));
    await intent(a, processed);
    // A cut-off in the future asks for every submission; the policy refuses the young one.
    const wrong = { ...cutoffs, submissionsBefore: ms(now, DAY) };
    expect(await applyRetention(operatorDb, a, wrong)).toMatchObject({ submissions: 0 });
    expect(await left('form_submissions', a, [fresh])).toEqual([fresh]);
    // Whatever a statement asks: no unprocessed event, no intent whose event exists.
    const direct = await inTenant(a, async (trx) => {
      await setRole(trx, 'mycel_retention');
      const events = await sql`delete from outbox where id = ${pending}`.execute(trx);
      const intents = await sql`delete from mail_sends where event_id = ${processed}`.execute(trx);
      const others = await sql`delete from outbox where tenant_id = ${b}`.execute(trx);
      return [events, intents, others].map((r) => Number(r.numAffectedRows ?? 0n));
    });
    expect(direct).toEqual([0, 0, 0]);
  });

  it('gives mycel_retention tenant-bound policies only, no update anywhere and no way in for the fronts', async () => {
    const { rows: role } = await sql<{ canlogin: boolean; app_member: boolean }>`
      select rolcanlogin as canlogin, pg_has_role('mycel_app', oid, 'MEMBER') as app_member
      from pg_roles where rolname = 'mycel_retention'`.execute(operatorDb);
    expect(role).toEqual([{ canlogin: false, app_member: false }]);
    const { rows: policies } = await sql<{ name: string; cmd: string; qual: string }>`
      select tablename || '.' || policyname as name, cmd, qual from pg_policies
      where schemaname = 'public' and 'mycel_retention' = any(roles) order by 1`.execute(
      operatorDb
    );
    expect(policies.map((p) => `${p.name} ${p.cmd}`)).toEqual([
      'connection_intents.retention_read SELECT',
      'form_submissions.retention_apply DELETE',
      'form_submissions.retention_read SELECT',
      'jobs.retention_read SELECT',
      'mail_sends.retention_apply DELETE',
      'mail_sends.retention_read SELECT',
      'outbox.retention_apply DELETE',
      'outbox.retention_read SELECT',
      'supporter_admissions.retention_apply DELETE',
      'supporter_admissions.retention_read SELECT',
    ]);
    for (const p of policies) expect(p.qual, p.name).toContain('tenant_id = current_tenant_id()');
    // What it may change is exactly the four tables with a `retention.apply` term, by delete only.
    const { rows: writes } = await sql<{ name: string; del: boolean; other: boolean }>`
      select c.relname as name, has_table_privilege('mycel_retention', c.oid, 'DELETE') as del,
             has_any_column_privilege('mycel_retention', c.oid, 'INSERT, UPDATE') as other
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and (has_table_privilege('mycel_retention', c.oid, 'DELETE')
             or has_any_column_privilege('mycel_retention', c.oid, 'INSERT, UPDATE'))
      order by 1`.execute(operatorDb);
    expect(writes).toEqual(
      Object.entries(STORAGE)
        .filter(([, e]) => e.retention.kind === 'term' && e.retention.by === 'retention.apply')
        .map(([name]) => ({ name, del: true, other: false }))
        .sort((x, y) => x.name.localeCompare(y.name))
    );
  });

  it('cannot be applied by the login of the fronts', async () => {
    await expect(applyRetention(appDb, a, cutoffs)).rejects.toThrow(/operator connection/);
  });
});
