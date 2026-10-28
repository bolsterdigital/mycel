// RLS conformance (ADR 002 consequences, ADR 011 consequences). Reads the live catalog after
// `migrate`, so a new migration that forgets the pattern from 0001 fails here without anyone
// having to remember to extend a list. Rejected: a hand-maintained table list, which is exactly
// the kind of list a forgotten table never makes it onto.
//
// Skips without DATABASE_URL (operator) and APP_DATABASE_URL (mycel_app); with E2E_REQUIRED=1
// (CI) a missing database is a failure, as in scripts/e2e.mjs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import {
  Invoker,
  buildRegistry,
  confirmationMailSubscriber,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  MemoryMailer,
  memoryImageProcessor,
  memoryPlatform,
  probeForm,
  publishProbePage,
} from '@mycel/core/testing';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  deleteExpiredAudit,
  migrate,
  TABLES,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from './index.js';
import { closeTenantWork } from './testing.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

const APP_ROLE = 'mycel_app';
// ADR 011 rule 1: cross-tenant (`using (true)`) policies exist only on platform queues, logs and
// counters: the outbox (worker drain, 0003) and the rate-limit windows (janitor sweep, 0006);
// plus the one exception, the identity tables read at authentication time (mycel_auth, 0007)
// and the hostnames read to resolve the site being visited (mycel_auth, 0008); and the jobs
// queue the worker claims from (mycel_worker, 0009); and the login-limit windows counted before
// any tenant exists (mycel_auth, 0018).
const CROSS_TENANT_TABLES = [
  'outbox',
  'rate_limits',
  'operators',
  'tenant_memberships',
  'api_keys',
  'tenant_hostnames',
  'jobs',
  'login_attempts',
];
const ISOLATION = '(tenant_id = current_tenant_id())';

interface TenantTable {
  name: string;
  rowsecurity: boolean;
  forcerowsecurity: boolean;
  /** Set for a partition: the table whose RLS and grants cover it (ADR 003, 0005). */
  parent: string | null;
}
interface Policy {
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

describe.skipIf(!operatorUrl || !appUrl)('row level security conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  let tenantId = '';
  let tables: TenantTable[] = [];
  let partitions: TenantTable[] = [];
  let partitionGrants: { name: string; granted: string[] }[] = [];
  let policies: Policy[] = [];
  let backupRecorded = false;

  /**
   * A backup record (TODO #29B, 0021), which only the backup login writes: as that login when the
   * drill hands its URL over, else as a superuser entering it (CI, the dev stack), made the way
   * init-backup-role.sh makes it when missing (as erasure-backups.test does). An ordinary
   * owner without that URL (the Mac) cannot, and the vacuity check below leaves the table out.
   */
  async function recordBackup(supporterId: string): Promise<boolean> {
    const insert = sql`insert into erasure_backups (tenant_id, supporter_id, snapshot_id)
                       values (${tenantId}, ${supporterId}, ${'ef'.repeat(32)})`;
    const backupUrl = process.env['DRILL_BACKUP_DATABASE_URL'];
    if (backupUrl) {
      const backupDb = createDb(backupUrl);
      try {
        await insert.execute(backupDb);
      } finally {
        await backupDb.destroy();
      }
      return true;
    }
    const { rows } = await sql<{ superuser: boolean }>`
      select rolsuper as superuser from pg_roles where rolname = current_user`.execute(operatorDb);
    if (!rows[0]?.superuser) return false;
    await sql`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'mycel_backup') then
          create role mycel_backup nologin nosuperuser bypassrls;
        end if;
      end $$`.execute(operatorDb);
    await sql`grant pg_read_all_data to mycel_backup`.execute(operatorDb);
    await sql`grant insert on erasure_backups to mycel_backup`.execute(operatorDb);
    await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_backup`.execute(trx);
      await insert.execute(trx);
    });
    return true;
  }

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      log: () => {},
    });

    // Every relation in `public` with a tenant_id column: plain and partitioned tables both.
    // Partitions are checked separately: their parent carries RLS and grants for them.
    const catalog = await operatorDb.transaction().execute(async (trx) => {
      // A partition DDL needs ACCESS EXCLUSIVE on events. Hold this lock only while reading
      // the catalog and its grants, so the snapshot cannot name a partition another suite drops.
      await sql`lock table events in access share mode`.execute(trx);
      const all = (
        await sql<TenantTable>`
        select c.relname as name, c.relrowsecurity as rowsecurity,
               c.relforcerowsecurity as forcerowsecurity, p.relname as parent
        from pg_class c join pg_attribute a on a.attrelid = c.oid
        left join pg_inherits i on i.inhrelid = c.oid
        left join pg_class p on p.oid = i.inhparent
        where a.attname = 'tenant_id' and not a.attisdropped and c.relkind in ('r', 'p')
          and c.relnamespace = 'public'::regnamespace
        order by c.relname`.execute(trx)
      ).rows;
      const partitions = all.filter((t) => t.parent !== null);
      const partitionGrants = [];
      for (const partition of partitions) {
        const { rows } = await sql<{ granted: string[] }>`
          select array(
            select p from unnest(array['select', 'insert', 'update', 'delete', 'truncate',
                                       'references', 'trigger']) p
            where has_table_privilege(${APP_ROLE}, ${`public.${partition.name}`}, p)
          ) as granted`.execute(trx);
        partitionGrants.push({ name: partition.name, granted: rows[0]!.granted });
      }
      const policies = (
        await sql<Policy>`
        select tablename, policyname, permissive, roles::text[] as roles, cmd, qual, with_check
        from pg_policies where schemaname = 'public'`.execute(trx)
      ).rows;
      return { all, partitions, partitionGrants, policies };
    });
    tables = catalog.all.filter((t) => t.parent === null);
    partitions = catalog.partitions;
    partitionGrants = catalog.partitionGrants;
    policies = catalog.policies;

    // Put at least one row for this tenant into every tenant table mycel_app can read, through
    // the real use-case path: a signup writes forms, submissions, rate limits and the
    // outbox; the confirmation mail writes its intent row. The subscribers are called directly
    // instead of draining the outbox: `drainOutbox` claims every tenant's events, so a drain here
    // would take other suites' events with only some of their subscribers. db.test.ts drains only
    // its own tenants for the same reason (TODO #26).
    tenantId = (
      await upsertTenant(
        operatorDb,
        {
          id: uuidv7(),
          slug: `rls-${run}`,
          name: 'RLS',
          defaultLocale: 'nl',
          locales: ['nl'],
        },
        { platformDomain: 'localhost' }
      )
    ).id;
    const clock = { now: () => new Date() };
    const signer = new FakeSigner();
    const uow = createUnitOfWork(appDb, {
      clock,
      ids: uuidv7Ids,
      signer,
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
      media: { blobs: new MemoryBlobStore(), images: memoryImageProcessor },
      connectionCredentialKey: '10'.repeat(32),
    });
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(tenantId, 'rls-test');
    await invoker.run(useCases.updateSiteTheme, admin, {
      baseVersion: 0,
      theme: useCases.updateSiteTheme.examples[0].input.theme,
    });
    const connection = await invoker.run(useCases.createConnection, admin, {
      provider: 'webhook',
      accountRef: null,
      externalOwner: 'RLS',
      maintainer: 'RLS',
      purpose: 'Fixture',
      direction: 'outbound',
      dataAuthority: 'mycel',
      consentAuthority: 'mycel',
      consentScopes: ['newsletter:rls'],
      formIds: [],
      destination: 'https://hooks.example.org/rls',
      contractVersion: 'v1',
      adapterVersion: 'v1',
    });
    await invoker.run(useCases.replaceConnectionCredential, admin, {
      id: connection.id,
      baseVersion: connection.version,
      secret: 'fixture-only',
    });
    await uow.run(admin, async (ctx) => {
      const intentId = uuidv7();
      await ctx.connectionIntents.insert({
        id: intentId,
        connectionId: connection.id,
        businessId: uuidv7(),
        connectionVersion: 2,
        credentialVersion: 1,
        source: 'fixture',
        mappingVersion: 'v1',
        supporterId: null,
        scope: 'newsletter:rls',
        actor: { kind: 'system', id: 'rls' },
        key: intentId,
        state: 'blocked',
        failure: 'erasure',
        attempts: 0,
        revision: 0,
        leaseToken: null,
        leaseUntil: null,
        nextAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      await ctx.connectionIntents.record({
        id: uuidv7(),
        intentId,
        at: clock.now(),
        kind: 'dispatch',
        outcome: 'blocked',
      });
    });
    const formId = uuidv7();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
    // Content (0011): an item with its revision and locale rows, plus an author, a section and
    // a pattern through their use cases.
    const page = await publishProbePage(invoker, admin, formId);
    await uow.run(admin, async (ctx) => {
      await ctx.assist.saveSettings({
        enabled: false,
        allowRestricted: false,
        consentedProvider: null,
        consentedBy: null,
        consentedAt: null,
      });
      await ctx.assist.insert({
        id: uuidv7(),
        itemId: page.id,
        baseRevisionId: page.latestRevisionId,
        blockId: 'fixture',
        locale: 'nl',
        status: 'failed',
        value: null,
        failure: 'unavailable',
        provider: 'fixture',
        requestedBy: null,
        model: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
    });
    await invoker.run(useCases.createAuthor, admin, { slug: 'rls', name: 'RLS' });
    await invoker.run(useCases.createSection, admin, { slug: 'rls', title: { nl: 'RLS' } });
    await invoker.run(useCases.createPattern, admin, {
      name: { nl: 'RLS' },
      intendedType: 'page',
      blocks: [],
    });
    const email = `rls-${run}@example.org`;
    const submitted = await invoker.run(useCases.submitForm, admin, {
      formId,
      values: { email, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(`fixture signup ${submitted.status}`);
    const event = {
      id: uuidv7(),
      type: 'newsletter.subscribed',
      tenantId,
      occurredAt: new Date(),
      actor: { kind: 'system' as const, job: 'rls-test' },
      props: {
        email,
        list: 'newsletter',
        formId,
        submissionId: submitted.submissionId,
        locale: 'nl',
        pageUrl: null,
        consentTextVersion: 'v1',
        confirmed: false,
      },
    };
    await supporterIngestSubscriber(uow).handle(event);
    // Ingest released that signup's admission seat (0010); a reservation without a signup keeps
    // one in `supporter_admissions`. Reserved directly, not through a second signup: that signup's
    // event would sit in the shared outbox, where any drain of every tenant (a running worker; and
    // db.test.ts until TODO #26 scoped it to its own tenants) could ingest it and release the seat
    // before the count below (a flaky fixture, seen on TODO #10's branch and in PR #23).
    await uow.run(admin, async (ctx) => {
      await ctx.admissions.lock();
      await ctx.admissions.reserve(`rls-pending-${run}@example.org`);
    });
    // That signup's outbox event can still be ingested by a worker draining every tenant, which
    // releases its seat; a reservation without an event cannot be.
    await uow.run(admin, (ctx) => ctx.admissions.reserve(`rls-reserved-${run}@example.org`));
    // An erasure registration (TODO #18d, 0019): the register holds a hash, never the address.
    const erased = uuidv7();
    await uow.run(admin, (ctx) => ctx.erasures.register(erased, `rls-erased-${run}@example.org`));
    backupRecorded = await recordBackup(erased);
    // An export request (TODO #28, 0022): the row only, no job is run here.
    await invoker.run(useCases.requestExport, admin, {});
    // Memberships and keys through their use cases (TODO #7).
    await invoker.run(useCases.inviteMember, admin, {
      email: `member-${run}@example.org`,
      capabilities: ['content:write'],
    });
    await invoker.run(useCases.createKey, admin, {
      name: 'rls',
      capabilities: ['content:read'],
    });
    // Media and a usage of it (TODO #10).
    const media = await invoker.run(
      useCases.uploadMedia,
      admin,
      useCases.uploadMedia.examples[0].input
    );
    await uow.run(admin, (ctx) =>
      ctx.media.replaceUsages(`item:${run}:rev:1`, [{ mediaId: media.id, blockId: 'b1' }])
    );
    await confirmationMailSubscriber({
      mailer: new MemoryMailer(),
      signer,
      clock,
      tenants: createTenantDirectory(appDb),
      uow,
      from: { email: 'noreply@example.org' },
      platform: memoryPlatform,
    }).handle(event);
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantId]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  // The registration point is `TABLES` in export.ts (every table of the schema, by kind): every
  // table that is not the platform's carries a tenant_id, so a new tenant table cannot hide from
  // this suite, and a vacuous catalog query cannot pass. Rejected: a hand-kept list here, which
  // fell behind (21 names at 33 tables).
  it('finds every non-platform table of TABLES as a tenant table, and no other', () => {
    /** Operational, but keyed before any tenant is known: the login window (0018). */
    const withoutTenant = ['login_attempts'];
    const expected = Object.entries(TABLES)
      .filter(([name, kind]) => kind !== 'platform' && !withoutTenant.includes(name))
      .map(([name]) => name)
      .sort();
    expect(tables.map((t) => t.name).sort()).toEqual(expected);
  });

  it('enables and forces RLS on every table with a tenant_id', () => {
    const failing = tables
      .filter((t) => !t.rowsecurity || !t.forcerowsecurity)
      .map((t) => `${t.name} (enabled=${t.rowsecurity}, forced=${t.forcerowsecurity})`);
    expect(failing).toEqual([]);
  });

  it('covers every partition through its parent: RLS forced there, no grants on the partition', () => {
    // Proves the check is not vacuous: 0005's default partition is the known instance.
    expect(partitions.map((p) => p.name)).toContain('events_default');
    for (const partition of partitions) {
      const parent = tables.find((t) => t.name === partition.parent);
      expect(
        parent,
        `${partition.name}: parent ${partition.parent} not a tenant table`
      ).toMatchObject({ rowsecurity: true, forcerowsecurity: true });
      expect(
        partitionGrants.find((p) => p.name === partition.name)?.granted,
        `${partition.name}: ${APP_ROLE} has rights on the partition`
      ).toEqual([]);
    }
  });

  it('keeps a partition present while its catalog row and grants are inspected', async () => {
    const name = 'events_2199_01';
    await sql`select ensure_event_partitions('2199-01-01', '2199-01-01')`.execute(operatorDb);
    const reader = new pg.Client({ connectionString: operatorUrl });
    const dropper = new pg.Client({ connectionString: operatorUrl });
    await Promise.all([reader.connect(), dropper.connect()]);
    try {
      await reader.query('begin');
      await reader.query('lock table events in access share mode');
      const snapshot = await reader.query<{ name: string }>(
        `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
         where i.inhparent = 'events'::regclass and c.relname = $1`,
        [name]
      );
      expect(snapshot.rows.map((r) => r.name)).toEqual([name]);
      await dropper.query(`set lock_timeout = '100ms'`);
      // The old two-phase check had no lock: this DROP completed between catalog and grant
      // reads, then has_table_privilege(name) raised 42P01. The new check holds it back.
      await expect(dropper.query(`drop table ${name}`)).rejects.toMatchObject({ code: '55P03' });
      const grants = await reader.query<{ granted: string[] }>(
        `select array(select p from unnest(array['select', 'insert', 'update', 'delete']) p
                      where has_table_privilege('mycel_app', $1, p)) as granted`,
        [`public.${name}`]
      );
      expect(grants.rows[0]?.granted).toEqual([]);
      await reader.query('commit');
      await dropper.query(`drop table ${name}`);
      await expect(
        reader.query(`select has_table_privilege('mycel_app', $1, 'select')`, [`public.${name}`])
      ).rejects.toMatchObject({ code: '42P01' });
    } finally {
      await reader.query('rollback').catch(() => {});
      await Promise.all([reader.end(), dropper.end()]);
      await sql.raw(`drop table if exists ${name}`).execute(operatorDb);
    }
  });

  it('gives every tenant table the tenant_isolation policy from 0001', () => {
    const failing = tables
      .filter((t) => {
        const p = policies.find(
          (p) => p.tablename === t.name && p.policyname === 'tenant_isolation'
        );
        return !(
          p &&
          p.permissive === 'PERMISSIVE' &&
          p.cmd === 'ALL' &&
          p.qual === ISOLATION &&
          p.with_check === ISOLATION &&
          // TODO #20b (0018): bound to mycel_app, so a future role with a grant on the table is
          // refused instead of falling under the policy.
          p.roles.length === 1 &&
          p.roles[0] === APP_ROLE
        );
      })
      .map((t) => t.name);
    expect(failing).toEqual([]);
  });

  it('binds every using (true) policy to a dedicated worker role (ADR 011)', async () => {
    const open = policies.filter((p) => p.qual === 'true' || p.with_check === 'true');
    // Proves the check is not vacuous: 0003's worker_drain is the known instance.
    expect(open.map((p) => `${p.tablename}.${p.policyname}`)).toContain('outbox.worker_drain');

    for (const p of open) {
      const where = `${p.tablename}.${p.policyname}`;
      expect(CROSS_TENANT_TABLES, `${where}: cross-tenant policy on a tenant data table`).toContain(
        p.tablename
      );
      expect(p.roles, `${where}: bound to public`).not.toContain('public');
      expect(p.roles, `${where}: bound to ${APP_ROLE}`).not.toContain(APP_ROLE);
      for (const role of p.roles) {
        // A worker role cannot log in (it is entered with `set local role`) and the application
        // role must not be able to enter it, directly or through membership.
        const { rows } = await sql<{ canlogin: boolean; app_member: boolean }>`
          select r.rolcanlogin as canlogin, pg_has_role(${APP_ROLE}, r.oid, 'MEMBER') as app_member
          from pg_roles r where r.rolname = ${role}`.execute(operatorDb);
        expect(rows, `${where}: role ${role} does not exist`).toHaveLength(1);
        expect(rows[0], `${where}: role ${role}`).toEqual({ canlogin: false, app_member: false });
      }
    }
  });

  // TODO #17a: a policy with a condition (0014's restrictive `worker_retention`) escapes the
  // `using (true)` rule above, so this one holds for every policy, `tenant_isolation` included
  // since TODO #20b (0018): it names its role, never `public`.
  it('binds every policy, tenant_isolation included, to a named role', () => {
    const loose = policies
      .filter((p) => p.roles.includes('public'))
      .map((p) => `${p.tablename}.${p.policyname}`);
    expect(loose).toEqual([]);
    // Not vacuous: every tenant table's isolation is bound to mycel_app (the test above).
    expect(
      policies
        .filter((p) => p.policyname === 'tenant_isolation')
        .every((p) => p.roles[0] === APP_ROLE)
    ).toBe(true);
    expect(policies.find((p) => p.policyname === 'worker_retention')).toMatchObject({
      tablename: 'jobs',
      permissive: 'RESTRICTIVE',
      roles: ['mycel_worker'],
      cmd: 'DELETE',
      qual: '(done_at IS NOT NULL)',
    });
  });

  // TODO #17c (0016): the ops reader never sees a payload, an event's props or its actor, and
  // changes only a stuck row, only into a retry or a close (the review of #17c: Postgres checks the
  // new row of an UPDATE against the select policies too, so reading is every row's metadata);
  // the application role reads its own jobs without the payload.
  describe('mycel_ops and the stuck-work grants', () => {
    const as = <T>(db: typeof appDb, role: string | null, fn: (trx: typeof appDb) => Promise<T>) =>
      db.transaction().execute(async (trx) => {
        if (role) await sql`set local role ${sql.id(role)}`.execute(trx);
        if (db === appDb)
          await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return fn(trx);
      });
    const job = (over: { attempts?: number; done?: boolean } = {}) => ({
      id: uuidv7(),
      tenant_id: tenantId,
      type: `rls.${run}`,
      key: `rls.${run}:${uuidv7()}`,
      run_at: new Date(Date.now() + 86_400_000),
      payload: JSON.stringify({ secret: 'payload' }),
      attempts: over.attempts ?? 10,
      max_attempts: 10,
      done_at: over.done ? new Date() : null,
    });
    // Built in beforeAll: the tenant id exists only once the outer fixture has run.
    let exhausted = job();
    let open = job();

    beforeAll(async () => {
      exhausted = job();
      open = job({ attempts: 2 });
      await as(operatorDb, 'mycel_worker', (trx) =>
        trx.insertInto('jobs').values([exhausted, open]).execute()
      );
    });
    afterAll(async () => {
      await as(operatorDb, 'mycel_worker', (trx) =>
        trx
          .updateTable('jobs')
          .set({ done_at: new Date() })
          .where('id', 'in', [exhausted.id, open.id])
          .execute()
      );
    });

    it('binds the ops policies to mycel_ops and the jobs isolation to mycel_app', () => {
      const of = (table: string, name: string) =>
        policies.find((p) => p.tablename === table && p.policyname === name);
      expect(of('jobs', 'ops_jobs')).toMatchObject({
        roles: ['mycel_ops'],
        cmd: 'SELECT',
        qual: 'true',
      });
      expect(of('jobs', 'ops_jobs_recover')).toMatchObject({
        roles: ['mycel_ops'],
        cmd: 'UPDATE',
        qual: '((done_at IS NULL) AND (attempts >= max_attempts))',
        with_check: '(((attempts = 0) AND (claimed_at IS NULL)) OR (done_at IS NOT NULL))',
      });
      expect(of('outbox', 'ops_outbox')).toMatchObject({
        roles: ['mycel_ops'],
        cmd: 'SELECT',
        qual: 'true',
      });
      expect(of('outbox', 'ops_outbox_recover')).toMatchObject({
        roles: ['mycel_ops'],
        cmd: 'UPDATE',
        qual: '((processed_at IS NULL) AND (attempts >= 10))',
        with_check: '(attempts = 0)',
      });
      expect(of('mail_sends', 'ops_mail')).toMatchObject({
        roles: ['mycel_ops'],
        cmd: 'SELECT',
        qual: '((sent_at IS NULL) AND (attempted_at IS NOT NULL))',
      });
      expect(of('jobs', 'tenant_isolation')?.roles).toEqual([APP_ROLE]);
    });

    it.each([
      ['jobs', 'payload'],
      ['outbox', 'props'],
      ['outbox', 'actor'],
      ['tenants', 'entitlements'],
    ])('denies mycel_ops %s.%s', async (table, column) => {
      await expect(
        as(operatorDb, 'mycel_ops', (trx) =>
          sql`select ${sql.ref(column)} from ${sql.table(table)} limit 1`.execute(trx)
        )
      ).rejects.toThrow(/permission denied/);
    });

    it('lets mycel_ops change an exhausted job only, and only into a retry or a close', async () => {
      const seen = await as(operatorDb, 'mycel_ops', (trx) =>
        trx
          .selectFrom('jobs')
          .select(['id', 'last_error'])
          .where('id', 'in', [exhausted.id, open.id])
          .execute()
      );
      expect(seen.map((r) => r.id).sort()).toEqual([exhausted.id, open.id].sort());
      const touched = await as(operatorDb, 'mycel_ops', (trx) =>
        trx.updateTable('jobs').set({ attempts: 0 }).where('id', '=', open.id).executeTakeFirst()
      );
      expect(touched.numUpdatedRows).toBe(0n);
      // Visible and exhausted, but the new row is neither a retry nor a close.
      await expect(
        as(operatorDb, 'mycel_ops', (trx) =>
          trx.updateTable('jobs').set({ attempts: 5 }).where('id', '=', exhausted.id).execute()
        )
      ).rejects.toThrow(/row-level security/);
      const retried = await as(operatorDb, 'mycel_ops', (trx) =>
        trx
          .updateTable('jobs')
          .set({ attempts: 0, claimed_at: null })
          .where('id', '=', exhausted.id)
          .executeTakeFirst()
      );
      expect(retried.numUpdatedRows).toBe(1n);
    });

    it('lets mycel_app read its own jobs without the payload, and nobody else’s', async () => {
      await expect(
        as(appDb, null, (trx) => trx.selectFrom('jobs').select('payload').execute())
      ).rejects.toThrow(/permission denied/);
      const own = await as(appDb, null, (trx) =>
        trx.selectFrom('jobs').select(['id', 'tenant_id']).execute()
      );
      expect(own.map((r) => r.id)).toEqual(expect.arrayContaining([exhausted.id, open.id]));
      expect(own.every((r) => r.tenant_id === tenantId)).toBe(true);
    });

    it('gives mycel_ops no insert or delete, and no update of the mail intents', async () => {
      const { rows } = await sql<{ p: string }>`
        select t || '.' || p as p
        from unnest(array['jobs', 'outbox', 'mail_sends', 'tenants', 'audit_log']) t,
             unnest(array['insert', 'delete', 'truncate']) p
        where has_table_privilege('mycel_ops', 'public.' || t, p)
        union all
        select 'mail_sends.update'
        where has_any_column_privilege('mycel_ops', 'public.mail_sends', 'update')`.execute(
        operatorDb
      );
      expect(rows).toEqual([]);
    });
  });

  // TODO #17b: the audit log is append-only for everyone; only the janitor deletes, and never a
  // row younger than 30 days, whatever its query asks.
  describe('audit_log', () => {
    /** One transaction on `db` with this tenant's context, optionally as another role. */
    const tx = <T>(
      db: typeof appDb,
      fn: (trx: typeof appDb) => Promise<T>,
      role?: string
    ): Promise<T> =>
      db.transaction().execute(async (trx) => {
        if (role) await sql`set local role ${sql.id(role)}`.execute(trx);
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return fn(trx);
      });
    const row = (actorKind: string, daysAgo = 0) => ({
      id: uuidv7(),
      tenant_id: tenantId,
      occurred_at: new Date(Date.now() - daysAgo * 86_400_000),
      actor_kind: actorKind,
      actor_id: 'rls',
      operation: 'rls.test',
      effect: null,
      input_hash: '0'.repeat(64),
      result: 'ok',
      request_id: null,
      subject_id: null,
    });

    it('holds a row per fixture command, without an address in any column', async () => {
      const rows = await tx(appDb, (trx) => trx.selectFrom('audit_log').selectAll().execute());
      expect(rows.map((r) => r.operation)).toEqual(
        expect.arrayContaining([
          'content.item.create',
          'content.item.publish',
          'forms.submit',
          'tenant.members.invite',
          'tenant.keys.create',
          'media.upload',
        ])
      );
      expect(rows.every((r) => r.result === 'ok' && /^[0-9a-f]{64}$/.test(r.input_hash))).toBe(
        true
      );
      expect(JSON.stringify(rows)).not.toContain('@');
    });

    it('lets mycel_app neither update nor delete a row', async () => {
      const { id } = row('system');
      await tx(appDb, (trx) =>
        trx
          .insertInto('audit_log')
          .values({ ...row('system'), id })
          .execute()
      );
      await expect(
        tx(appDb, (trx) =>
          trx.updateTable('audit_log').set({ result: 'forged' }).where('id', '=', id).execute()
        )
      ).rejects.toThrow(/permission denied/);
      await expect(
        tx(appDb, (trx) => trx.deleteFrom('audit_log').where('id', '=', id).execute())
      ).rejects.toThrow(/permission denied/);
    });

    it('lets mycel_platform insert platform rows only', async () => {
      await tx(
        operatorDb,
        (trx) => trx.insertInto('audit_log').values(row('platform')).execute(),
        'mycel_platform'
      );
      await expect(
        tx(
          operatorDb,
          (trx) => trx.insertInto('audit_log').values(row('operator')).execute(),
          'mycel_platform'
        )
      ).rejects.toThrow(/row-level security/);
    });

    it('lets mycel_audit_janitor delete only rows older than 30 days, also with an explicit where', async () => {
      const young = row('system', 29);
      const old = row('system', 31);
      await tx(appDb, (trx) => trx.insertInto('audit_log').values([young, old]).execute());
      const deleted = await tx(
        operatorDb,
        (trx) => trx.deleteFrom('audit_log').where('id', '=', young.id).executeTakeFirst(),
        'mycel_audit_janitor'
      );
      expect(deleted.numDeletedRows).toBe(0n);
      // A retention of one day still keeps the 30-day floor.
      expect(await deleteExpiredAudit(operatorDb, 1)).toBeGreaterThanOrEqual(1);
      const left = await tx(appDb, (trx) =>
        trx.selectFrom('audit_log').select('id').where('id', 'in', [young.id, old.id]).execute()
      );
      expect(left.map((r) => r.id)).toEqual([young.id]);
    });
  });

  // TODO #20b (0018): the login limit is the platform's, counted through mycel_auth only, and
  // the schema owner sees no tenant row without entering mycel_app.
  describe('login_attempts and the owner', () => {
    it('is enabled and forced, readable and writable by mycel_auth, swept by the janitor', async () => {
      const { rows } = await sql<{ rls: boolean; forced: boolean }>`
        select relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'public.login_attempts'::regclass`.execute(operatorDb);
      expect(rows[0]).toEqual({ rls: true, forced: true });
      const of = (name: string) =>
        policies.find((p) => p.tablename === 'login_attempts' && p.policyname === name);
      expect(of('auth_login_limit')).toMatchObject({ roles: ['mycel_auth'], cmd: 'ALL' });
      const old = "(window_start < (now() - '1 day'::interval))";
      expect(of('janitor_read')).toMatchObject({
        roles: ['mycel_janitor'],
        cmd: 'SELECT',
        qual: old,
      });
      expect(of('janitor_sweep')).toMatchObject({
        roles: ['mycel_janitor'],
        cmd: 'DELETE',
        qual: old,
      });
    });

    it.each([
      ['select', sql`select count(*) from login_attempts`],
      ['insert', sql`insert into login_attempts values ('rls-xxxxxxxxxxxxxxxx', now(), 1)`],
    ])('denies mycel_app %s on login_attempts', async (_label, query) => {
      await expect(query.execute(appDb)).rejects.toThrow(/permission denied/);
    });

    it('shows the owner no tenant row unless it enters mycel_app', async () => {
      const count = (trx: typeof operatorDb) =>
        sql<{ n: string }>`select count(*) as n from forms where tenant_id = ${tenantId}`
          .execute(trx)
          .then((r) => Number(r.rows[0]?.n));
      const { rows } = await sql<{ s: boolean }>`
        select rolsuper as s from pg_roles where rolname = current_user`.execute(operatorDb);
      const asOwner = await operatorDb.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return count(trx);
      });
      const asApp = await operatorDb.transaction().execute(async (trx) => {
        await sql`set local role mycel_app`.execute(trx);
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return count(trx);
      });
      // A superuser bypasses RLS altogether (CI's service container); the owner of the local
      // and managed setups does not, and that is the case this binding is for.
      if (!rows[0]?.s) expect(asOwner).toBe(0);
      expect(asApp).toBeGreaterThan(0);
    });

    // The case the binding is for, on any operator: a role that holds a grant on a tenant table
    // but is not mycel_app falls under no policy and sees nothing, even with a tenant context.
    it('refuses a role with a grant that is not mycel_app', async () => {
      const role = `rls_outsider_${run}`;
      const client = new pg.Client({ connectionString: operatorUrl });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`create role ${role} nologin`);
        await client.query(`grant ${role} to current_user`);
        await client.query(`grant select, insert on forms to ${role}`);
        await client.query(`set local role ${role}`);
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        const { rows } = await client.query<{ n: string }>('select count(*) as n from forms');
        expect(Number(rows[0]?.n)).toBe(0);
        await expect(
          client.query(`insert into forms (id, tenant_id, definition) values ($1, $2, '{}')`, [
            uuidv7(),
            tenantId,
          ])
        ).rejects.toThrow(/row-level security/);
      } finally {
        await client.query('rollback').catch(() => {});
        await client.end();
      }
    });
  });

  // ADR 011 consequences (TODO #18c, #29B): the backup login is the one role that bypasses RLS,
  // and it can only read, plus insert which registrations its snapshot holds (0021). Created by
  // the image's superuser, so a database without it (the Mac) passes on the first assertion
  // alone; the drill, the compose stack and recordBackup above (as superuser) have it. This is the
  // one place for RLS bypass: the runtime logins' superuser and ownership flags are in
  // operators.test.ts, mycel_platform's in entitlements.test.ts.
  it('lets no role but mycel_backup bypass RLS, and that one only read and record backups', async () => {
    const { rows: bypassing } = await sql<{ name: string }>`
      select rolname as name from pg_roles
      where rolbypassrls and not rolsuper order by rolname`.execute(operatorDb);
    expect(bypassing.map((r) => r.name).filter((n) => n !== 'mycel_backup')).toEqual([]);
    const { rows } = await sql<{
      createrole: boolean;
      owns: string[];
      inserts: string[];
      changes: string[];
    }>`
      select r.rolcreaterole as createrole,
             array(select c.relname::text from pg_class c
                   where c.relowner = r.oid and c.relnamespace = 'public'::regnamespace) as owns,
             array(select distinct c.relname::text from pg_class c
                   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                     and has_table_privilege(r.oid, c.oid, 'insert')) as inserts,
             array(select distinct c.relname::text from pg_class c
                   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                     and (has_table_privilege(r.oid, c.oid, 'update')
                       or has_table_privilege(r.oid, c.oid, 'delete')
                       or has_table_privilege(r.oid, c.oid, 'truncate'))) as changes
      from pg_roles r where r.rolname = 'mycel_backup'`.execute(operatorDb);
    if (rows[0])
      expect(rows[0]).toEqual({
        createrole: false,
        owns: [],
        inserts: ['erasure_backups'],
        changes: [],
      });
  });

  it('returns nothing to mycel_app without set_config, and the seeded rows with it', async () => {
    // A fresh connection, not the pool: nothing can have left a setting behind on it.
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      const { rows: who } = await client.query<{ u: string; t: string | null }>(
        `select current_user as u, current_setting('app.tenant_id', true) as t`
      );
      expect(who[0]?.u).toBe(APP_ROLE);
      expect(who[0]?.t ?? '').toBe('');

      const counts: Record<string, { without: number; within: number } | 'no select'> = {};
      for (const { name } of tables) {
        // Any column: `jobs` is readable on its columns only, never the payload (0016).
        const { rows: priv } = await client.query<{ ok: boolean }>(
          `select has_any_column_privilege(current_user, $1, 'select') as ok`,
          [`public.${name}`]
        );
        if (!priv[0]?.ok) {
          counts[name] = 'no select';
          continue;
        }
        const ident = client.escapeIdentifier(name);
        await client.query('begin');
        const without = await client.query<{ n: string }>(`select count(*) as n from ${ident}`);
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        const within = await client.query<{ n: string }>(`select count(*) as n from ${ident}`);
        await client.query('commit');
        counts[name] = { without: Number(without.rows[0]?.n), within: Number(within.rows[0]?.n) };
      }

      for (const [name, c] of Object.entries(counts)) {
        if (c === 'no select') continue;
        if (name === 'erasure_backups' && !backupRecorded) {
          if (process.env['E2E_REQUIRED'] === '1')
            throw new Error('E2E_REQUIRED=1 but no backup record could be written');
          continue;
        }
        expect(c.without, `${name}: rows visible without a tenant context`).toBe(0);
        // Without seeded rows the zero above would prove nothing. A new tenant table needs a
        // row in this test's fixture (beforeAll) before it can pass.
        expect(
          c.within,
          `${name}: fixture wrote no row, so the check above is vacuous`
        ).toBeGreaterThan(0);
      }
      // The outbox is write-only for the app; the worker role reads it (ADR 011).
      expect(counts['outbox']).toBe('no select');
    } finally {
      await client.end();
    }
  });
});
