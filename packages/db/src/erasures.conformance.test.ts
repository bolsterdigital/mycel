// Erasure conformance against Postgres (TODO #18d, migration 0019; ADR 003 rule 5, ADR 019 rule
// 8): after `register` plus `apply` the address is in no row of the tenant, the event count holds,
// a second apply changes nothing, the other tenant keeps the same address, and the register is
// permanent and invisible to the roles that have no business with it. The fixture goes through the
// real paths: a signup (submission, outbox event), ingest (events, projection) and the
// confirmation mail (intent row, reconcile job), with the subscribers fed the outbox's own events.
// packages/core/src/supporters/erasure.test.ts holds the memory adapter to the same contract.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  confirmationMailSubscriber,
  formMailSubscriber,
  DEFAULT_ACCESS,
  emailKey,
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
  runSuffix,
} from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  readOutboxEvent,
  uuidv7,
  uuidv7Ids,
} from './index.js';
import { asRole } from './infra/roles.js';
import { STORAGE } from './portability/storage.js';
import { closeTenantWork, requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('erasure conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const email = `erase-me-${run}@example.org`;
  const other = `keep-me-${run}@example.org`;
  const clock = { now: () => new Date() };
  const signer = new FakeSigner();
  const deps = {
    clock,
    ids: uuidv7Ids,
    signer,
    connectionCredentialKey: 'ab'.repeat(32),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  };
  const uow = createUnitOfWork(appDb, deps);
  const invoker = new Invoker(buildRegistry(), uow);
  const tenants: Record<'a' | 'b', string> = { a: '', b: '' };
  let supporterId = '';
  const campaignIds: string[] = [];

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
      out[table] = await asRole(operatorDb, role, async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
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

  const mailCopyIds = new Map<string, string[]>();
  /** A signup, its ingest and its confirmation mail, through the outbox's own events. */
  async function signup(tenantId: string, address: string, mailUow: UnitOfWork) {
    const admin = systemPrincipal(tenantId, 'erasure-test');
    const formId = uuidv7();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
    await uow.run(admin, async (ctx) => {
      const c = await ctx.connections.insert(
        {
          id: ctx.ids.next(),
          provider: 'webhook',
          accountRef: null,
          externalOwner: 'Example',
          maintainer: 'Operator',
          purpose: 'Newsletter',
          direction: 'outbound',
          dataAuthority: 'mycel',
          consentAuthority: 'mycel',
          consentScopes: ['newsletter'],
          formIds: [formId],
          destination: 'https://hooks.example.org/feed',
          contractVersion: 'v1',
          adapterVersion: 'v1',
        },
        clock.now()
      );
      const credential = (await ctx.connections.replaceCredential(
        c.id,
        c.version,
        'synthetic-secret',
        clock.now()
      ))!;
      const connected = (await ctx.connections.state(
        c.id,
        credential.version,
        'active',
        clock.now()
      ))!;
      const feeds = await ctx.formFeeds.get();
      await ctx.formFeeds.save(
        feeds.version,
        {
          feeds: [
            ...feeds.value.feeds,
            {
              id: `feed-${feeds.version}`,
              formId,
              enabled: true,
              connectionId: c.id,
              connectionVersion: connected.version,
              scope: 'newsletter',
              confirmationOwner: 'mycel',
              mapping: [{ fieldId: 'email', target: 'email' }],
            },
          ],
        },
        { kind: 'system', id: 'erasure-test' }
      );
    });
    const state = await uow.run(admin, (ctx) => ctx.formMail.get());
    await invoker.run(useCases.updateFormMailSettings, admin, {
      baseVersion: state.version,
      value: {
        templates: [],
        forms: [
          ...state.value.forms,
          {
            formId,
            confirmation: {
              override: {
                text: {
                  nl: 'Private biography {{field:email}}',
                  en: 'Private biography {{field:email}}',
                },
              },
            },
            enabled: true,
            actions: [
              {
                id: 'team',
                kind: 'notification',
                enabled: true,
                recipients: ['team@example.org'],
                template: { override: { text: { en: '{{field:email}}', nl: '{{field:email}}' } } },
              },
            ],
          },
        ],
      },
    });
    const submitted = await invoker.run(useCases.submitForm, admin, {
      formId,
      values: { email: address, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(`signup ${submitted.status}`);
    expect(
      (await uow.run(admin, (ctx) => ctx.submissions.findById(submitted.submissionId)))?.evaluation
    ).toMatchObject({
      activeFieldIds: ['email', 'consent'],
      feedActions: [expect.objectContaining({ feed: expect.objectContaining({ formId }) })],
    });
    const ids = await asRole(operatorDb, 'mycel_worker', async (trx) => {
      return (
        await sql<{ id: string }>`select id from outbox where tenant_id = ${tenantId}
        and props->>'submissionId' = ${submitted.submissionId}`.execute(trx)
      ).rows;
    });
    for (const { id } of ids) {
      const event = (await readOutboxEvent(operatorDb, id))!;
      if (event.props['email'] === address) {
        const k = `${tenantId}:${address}`;
        mailCopyIds.set(k, [...(mailCopyIds.get(k) ?? []), id]);
      }
      if (event.type === 'form.mail.planned') {
        await formMailSubscriber({
          mailer: new MemoryMailer(),
          clock,
          uow: mailUow,
          from: { email: 'noreply@example.org' },
          access: async () => DEFAULT_ACCESS,
        }).handle(event);
      }
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
    await migrateSchema(operatorUrl);
    for (const key of ['a', 'b'] as const)
      tenants[key] = (
        await testTenant(operatorDb, `erase-${key}-${run}`, { name: `Erase ${key}` })
      ).id;
    // Bulk preparation is an editorial archive, not a copy of supporter state. Include it in
    // the every-table scan so new plan fields cannot silently start caching signup data.
    const editor = systemPrincipal(tenants.a, 'editorial-archive');
    const article = await invoker.run(useCases.createItem, editor, {
      document: {
        type: 'page',
        title: { nl: 'Editorial' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [],
      },
    });
    const bulk = await invoker.run(useCases.createBulk, editor, {
      locale: 'nl',
      items: [
        {
          itemId: article.item.id,
          baseRevisionId: article.revision.id,
          operation: { kind: 'unpublish' },
        },
      ],
    });
    await invoker.run(useCases.resumeBulk, editor, { planId: bulk.id, version: 1 });
    await signup(tenants.a, email, uow);
    await signup(tenants.a, other, uow);
    // Tenant B has a supporter with the very same address: an erasure is one tenant's business.
    await signup(tenants.b, email, uow);
    // Delivered by hand above; a worker of another checkout on this database would deliver the
    // same events with its own code while the tests below count rows, so close them now.
    await closeTenantWork(operatorDb, [tenants.a, tenants.b]);
    supporterId = (await uow.run(systemPrincipal(tenants.a, 'erasure-test'), (ctx) =>
      ctx.supporters.getProjection(email)
    ))!.id;
    // ADR 033 rule 8: a confirmed and a withdrawn participation of the supporter to erase, and a
    // confirmed one of the supporter who stays. The confirmation path writes these.
    const otherId = (await uow.run(systemPrincipal(tenants.a, 'erasure-test'), (ctx) =>
      ctx.supporters.getProjection(other)
    ))!.id;
    for (const slug of ['petitie', 'aanmelding']) {
      const landing = await invoker.run(useCases.createItem, editor, {
        slug,
        document: {
          type: 'page',
          title: { nl: slug },
          defaultLocale: 'nl',
          locales: ['nl'],
          blocks: [],
        },
      });
      campaignIds.push(
        (
          await invoker.run(useCases.createCampaign, editor, {
            kind: 'signup',
            landingItemId: landing.item.id,
          })
        ).id
      );
    }
    await asRole(operatorDb, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenants.a}, true)`.execute(trx);
      for (const [campaign, supporter, withdrawn] of [
        [campaignIds[0], supporterId, null],
        [campaignIds[1], supporterId, new Date().toISOString()],
        [campaignIds[0], otherId, null],
      ])
        await sql`insert into campaign_participations
          (tenant_id, campaign_id, supporter_id, submission_id, confirmed_at, withdrawn_at)
          values (${tenants.a}, ${campaign}, ${supporter}, ${uuidv7()}, now() - interval '1 hour',
            ${withdrawn}::timestamptz)`.execute(trx);
    });
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenants.a, tenants.b]);
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

  // The storage catalog (portability/storage.ts) is the list of what apply covers. Every table in which the fixture
  // left the address, its admission key or the supporter's id names a supporter copy there, and
  // the tables apply may change are exactly its `apply` copies: a new grant to mycel_erasure, or a
  // copy marked `apply` that the eraser cannot reach, fails here.
  it('finds every copy of the fixture, and every table apply changes, in the storage catalog', async () => {
    const before = await rowsOf(tenants.a);
    const seat = await emailKey(tenants.a, email, 'admission');
    const copies = [
      ...new Set([
        ...holding(before, email),
        ...holding(before, seat),
        ...holding(before, supporterId),
      ]),
    ];
    const supporterCopy = (table: string) =>
      (STORAGE[table as keyof typeof STORAGE]?.copies ?? []).some((c) => c.subject === 'supporter');
    expect(
      copies.filter((t) => !supporterCopy(t)),
      'copies without a supporter entry'
    ).toEqual([]);
    expect(copies).toEqual(expect.arrayContaining(['events', 'supporters', 'form_submissions']));

    const { rows } = await sql<{ name: string }>`
      select c.relname as name from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and not c.relispartition
        and (has_table_privilege('mycel_erasure', c.oid, 'DELETE')
             or has_any_column_privilege('mycel_erasure', c.oid, 'UPDATE'))
      order by 1`.execute(operatorDb);
    // Apply may also change a count that holds no person, each reviewed here with its reason.
    const counters = new Map([
      ['campaigns', 'erased_count adds erased participations without an identifier (ADR 033)'],
    ]);
    const applied = [
      ...Object.entries(STORAGE)
        .filter(([, e]) => e.copies.some((c) => c.route.kind === 'apply'))
        .map(([name]) => name),
      ...counters.keys(),
    ].sort();
    expect(rows.map((r) => r.name)).toEqual(applied);
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
    for (const id of mailCopyIds.get(`${tenants.a}:${email}`) ?? []) {
      const event = (await readOutboxEvent(operatorDb, id))!;
      if (event.type === 'form.mail.planned') expect(event.props).toEqual({});
      else expect(event.props).not.toHaveProperty('confirmationCopy');
    }
    // Nor its admission key. A rate-limit bucket keys on the same value and stays: a
    // hash that lives a day at most is no copy (ADR 019 rule 8).
    const seat = await emailKey(tenants.a, email, 'admission');
    expect(holding(after, seat).filter((t) => t !== 'rate_limits')).toEqual([]);
    expect(after['events']!.length).toBe(before['events']!.length);
    expect(after['events']!.some((r) => r.includes(`${supporterId}@erased.invalid`))).toBe(true);
    // The intents and reconcile jobs of the erased signup went; the other supporter's stayed.
    // Both the opt-in and the team notification carried this submission's address.
    expect(after['mail_sends']!.length).toBe(before['mail_sends']!.length - 2);
    expect(holding(after, other)).toEqual(
      expect.arrayContaining(['events', 'supporters', 'form_submissions', 'outbox'])
    );
    expect(after['content_bulk_plans']).toHaveLength(1);
    expect(after['content_bulk_plan_items']).toHaveLength(1);
    expect(after['content_bulk_runs']).toHaveLength(1);
    expect(after['content_bulk_effects']).toHaveLength(1);
    expect(after['audit_log']!.length).toBeGreaterThanOrEqual(before['audit_log']!.length);
  });

  it('is idempotent: a second apply changes nothing', async () => {
    expect(await applyErasures(operatorDb, tenants.a)).toBe(0);
  });

  it('turns the participations into an anonymous count that never drops (ADR 033 rule 8)', async () => {
    const counts = await asRole(operatorDb, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenants.a}, true)`.execute(trx);
      const campaigns = await sql<{ id: string; erased_count: number }>`
        select id, erased_count from campaigns where id = any(${campaignIds}::uuid[])`.execute(trx);
      const left = await sql<{ campaign_id: string; supporter_id: string }>`
        select campaign_id, supporter_id from campaign_participations`.execute(trx);
      return { campaigns: campaigns.rows, left: left.rows };
    });
    // The confirmed one counts; the withdrawn one went without counting.
    expect(Object.fromEntries(counts.campaigns.map((c) => [c.id, c.erased_count]))).toEqual({
      [campaignIds[0]!]: 1,
      [campaignIds[1]!]: 0,
    });
    // Only the supporter who stays is left: active rows plus the count give the same public 2.
    expect(counts.left.map((r) => r.supporter_id)).not.toContain(supporterId);
    expect(counts.left).toHaveLength(1);
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

  it('keeps prefix and suffix neighbours and their mail intents and jobs unchanged', async () => {
    const tenant = (await testTenant(operatorDb, `erase-neighbours-${run}`)).id;
    try {
      const target = `ann-${run}@example.org`;
      const neighbours = [`jo${target}`, `${target}.evil`];
      for (const address of [target, ...neighbours]) await signup(tenant, address, uow);
      await asRole(operatorDb, 'mycel_app', async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenant}, true)`.execute(trx);
        for (const address of [target, ...neighbours]) {
          const id = uuidv7();
          const payload = JSON.stringify({ nested: [`Contact (${address}), please`] });
          await sql`insert into jobs (id, tenant_id, type, key, run_at, payload)
            values (${id}, ${tenant}, 'erasure-fixture', ${id}, now(), ${payload}::jsonb)`.execute(
            trx
          );
          await sql`insert into outbox (id, tenant_id, type, occurred_at, actor, props)
            values (${uuidv7()}, ${tenant}, 'form.mail.planned', now(),
              '{"kind":"system","id":"test"}'::jsonb, ${payload}::jsonb)`.execute(trx);
        }
      });
      await closeTenantWork(operatorDb, [tenant]);
      const before = await rowsOf(tenant);
      const admin = systemPrincipal(tenant, 'erasure-test');
      const supporter = (await uow.run(admin, (ctx) => ctx.supporters.getProjection(target)))!;
      await uow.run(admin, (ctx) => ctx.erasures.register(supporter.id, target.toUpperCase()));
      await applyErasures(operatorDb, tenant);
      const after = await rowsOf(tenant);
      for (const address of neighbours)
        for (const table of ['events', 'supporters', 'form_submissions', 'outbox', 'jobs'])
          expect(
            after[table]!.filter((row) => row.includes(address)),
            table
          ).toEqual(before[table]!.filter((row) => row.includes(address)));
      expect(after['mail_sends']).toHaveLength(before['mail_sends']!.length - 2);
      expect(after['jobs']).toHaveLength(before['jobs']!.length - 3);
      expect(await applyErasures(operatorDb, tenant)).toBe(0);
    } finally {
      await closeTenantWork(operatorDb, [tenant]);
    }
  });

  it.each(['\u00a0ANN@Example.org\u00a0', '\ufeffİN@Example.org\ufeff'])(
    'finds a restored submission by the core-normalised hash: %s',
    async (address) => {
      const tenant = (await testTenant(operatorDb, `erase-unicode-${uuidv7()}`)).id;
      const admin = systemPrincipal(tenant, 'erasure-test');
      try {
        await uow.run(admin, async (ctx) => {
          const formId = ctx.ids.next();
          await ctx.forms.insert(probeForm(formId));
          await ctx.submissions.insert({
            id: ctx.ids.next(),
            formId,
            values: { email: address },
            locale: 'nl',
            pageUrl: null,
            ipHash: null,
            createdAt: clock.now(),
            list: 'newsletter',
            consentTextVersion: 'v1',
            confirmedAt: null,
            evaluation: null,
          });
          await ctx.erasures.register(ctx.ids.next(), address.trim().toLowerCase());
        });
        expect((await rowsOf(tenant))['form_submissions']).toHaveLength(1);
        expect(await applyErasures(operatorDb, tenant)).toBe(1);
        expect((await rowsOf(tenant))['form_submissions']).toEqual([]);
        expect(await applyErasures(operatorDb, tenant)).toBe(0);
      } finally {
        await closeTenantWork(operatorDb, [tenant]);
      }
    }
  );

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

  it('gives mycel_erasure tenant-bound policies only, and no way in for the fronts', async () => {
    const { rows: role } = await sql<{ canlogin: boolean; app_member: boolean }>`
      select rolcanlogin as canlogin, pg_has_role('mycel_app', oid, 'MEMBER') as app_member
      from pg_roles where rolname = 'mycel_erasure'`.execute(operatorDb);
    expect(role).toEqual([{ canlogin: false, app_member: false }]);
    const { rows: policies } = await sql<{
      name: string;
      qual: string | null;
      check: string | null;
    }>`
      select tablename || '.' || policyname as name, qual, with_check as check from pg_policies
      where schemaname = 'public' and 'mycel_erasure' = any(roles) order by 1`.execute(operatorDb);
    expect(policies.map((p) => p.name)).toEqual([
      'campaign_participations.erasure_apply',
      'campaigns.erasure_apply',
      'connection_intents.erasure',
      'erasures.erasure_apply',
      'events.erasure_apply',
      'form_submissions.erasure_apply',
      'jobs.erasure_apply',
      'mail_sends.erasure_apply',
      'mailchimp_receipts.erasure_delete',
      'mailchimp_receipts.erasure_select',
      'outbox.erasure_apply',
      'supporter_admissions.erasure_apply',
      'supporter_lifecycles.erasure_apply',
      'supporters.erasure_apply',
      'tenant_exports.erasure_apply',
    ]);
    for (const p of policies) {
      expect(p.qual, p.name).toBe('(tenant_id = current_tenant_id())');
      if (p.check) expect(p.check, p.name).toBe('(tenant_id = current_tenant_id())');
    }
  });

  it('is invisible to mycel_auth and mycel_platform', async () => {
    const { rows } = await sql<{ role: string; granted: boolean }>`
      select r as role, has_table_privilege(r, 'public.erasures', 'select') as granted
      from unnest(array['mycel_auth', 'mycel_platform', 'mycel_ops', 'mycel_worker']) r`.execute(
      operatorDb
    );
    expect(rows.filter((r) => r.granted)).toEqual([]);
  });
  it('preserves a new explicit lifecycle across two applies, then erases that lifecycle too', async () => {
    const tenant = (await testTenant(operatorDb, `readmit-${run}`, { name: 'Readmission' })).id;
    const admin = systemPrincipal(tenant, 'readmission');
    const address = `readmit-${run}@example.org`;
    await signup(tenant, address, uow);
    const old = (await uow.run(admin, (ctx) => ctx.supporters.getProjection(address)))!;
    await uow.run(admin, (ctx) => ctx.erasures.register(old.id, address));
    await applyErasures(operatorDb, tenant);
    await signup(tenant, address, uow);
    await closeTenantWork(operatorDb, [tenant]);
    const next = (await uow.run(admin, (ctx) => ctx.supporters.getProjection(address)))!;
    expect(next.id).not.toBe(old.id);
    await applyErasures(operatorDb, tenant);
    expect(await uow.run(admin, (ctx) => ctx.supporters.getProjection(address))).toEqual(next);
    expect(await applyErasures(operatorDb, tenant)).toBe(0);
    await uow.run(admin, (ctx) => ctx.erasures.register(next.id, address));
    await applyErasures(operatorDb, tenant);
    expect(await uow.run(admin, (ctx) => ctx.supporters.getProjection(address))).toBeNull();
    expect(await uow.run(admin, (ctx) => ctx.erasures.status())).toMatchObject({ registered: 2 });
  });
});
