// Reader sign-in against Postgres (migration 0069, ADR 016 rule 1, ADR 019 rules 5 to 8): what
// the in-memory store cannot prove. Two units of work stand in for two processes: five requests
// across them send one mail and a link used twice at once has exactly one winner. A link and a
// session of tenant A are no rows to tenant B or without a tenant; `mycel_app` can end a link or
// a session and nothing else; an erasure deletes the pending link, its mail intent and the
// session; the sweep deletes only what expired. The flow itself is
// packages/core/src/readers/readers.test.ts.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  SIGNIN_FORM_SCOPE,
  SIGNIN_LINK_TTL_MS,
  SIGNIN_MAIL_SUBSCRIBER,
  anonymousPrincipal,
  buildRegistry,
  issueStartedToken,
  readerPrincipal,
  sendOnce,
  signinToken,
  systemPrincipal,
  useCases,
  type MailMessage,
  type UnitOfWork,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryMailer,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createUnitOfWork,
  sweepRateLimits,
  uuidv7Ids,
  withTenant,
} from '../index.js';
import { asRole, closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('reader sign-in conformance', () => {
  const operatorDb = createDb(operatorUrl);
  // Two pools and two units of work: two processes that share nothing but the database.
  const pools = [createDb(appUrl), createDb(appUrl)];
  const signer = new FakeSigner();
  let ahead = 0;
  const clock = { now: () => new Date(Date.now() + ahead) };
  const uows: UnitOfWork[] = pools.map((db) =>
    createUnitOfWork(db, {
      clock,
      ids: uuidv7Ids,
      signer,
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    })
  );
  const [uow] = uows as [UnitOfWork, UnitOfWork];
  const invokers = uows.map((u) => new Invoker(buildRegistry(), u));
  const [invoker] = invokers as [Invoker, Invoker];
  const run = runSuffix();
  let a = '';
  let b = '';

  const visitor = (tenant: string, ip = `ip-${run}`) =>
    anonymousPrincipal(tenant, ['content:read'], ip);
  const admin = (tenant: string) => systemPrincipal(tenant, 'test');
  const request = async (tenant: string, email: string, via = invoker, ip?: string) =>
    via.run(useCases.requestSignin, visitor(tenant, ip), {
      email,
      locale: 'nl',
      spam: {
        honeypot: '',
        startedToken: await issueStartedToken(
          signer,
          SIGNIN_FORM_SCOPE,
          new Date(clock.now().getTime() - 5000)
        ),
      },
    });
  const links = (tenant: string, email: string) =>
    withTenant(operatorDb, admin(tenant), (trx) =>
      trx.selectFrom('reader_signin_links').selectAll().where('email', '=', email).execute()
    );
  /** The token of the newest link for the address, signed as the mail source signs it. */
  async function tokenFor(tenant: string, email: string) {
    const row = (await links(tenant, email)).at(-1)!;
    return signinToken(signer, tenant, { id: row.id, expiresAt: new Date(row.expires_at) });
  }
  const complete = (tenant: string, token: string, via = invoker) =>
    via.run(useCases.completeSignin, visitor(tenant), { token });
  const sessionOf = async (tenant: string, token: string) =>
    (await invoker.run(useCases.getReaderSession, visitor(tenant), { token })).session;
  async function signedIn(tenant: string, email: string) {
    await request(tenant, email, invoker, `ip-${email}`);
    const done = await complete(tenant, await tokenFor(tenant, email));
    if (done.status !== 'signed_in') throw new Error(done.status);
    return done;
  }
  const count = async (table: 'reader_signin_links' | 'reader_sessions', tenant: string) =>
    Number(
      (
        await withTenant(operatorDb, admin(tenant), (trx) =>
          trx
            .selectFrom(table)
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow()
        )
      ).n
    );

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    a = (await testTenant(operatorDb, `rdr-a-${run}`)).id;
    b = (await testTenant(operatorDb, `rdr-b-${run}`)).id;
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [a, b]);
    await operatorDb.destroy();
    await Promise.all(pools.map((p) => p.destroy()));
  });

  it('sends one mail for five requests over two processes, per tenant', async () => {
    const email = `five-${run}@example.org`;
    const answers = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => request(a, email, invokers[i % 2], `ip-five-${i}`))
    );
    expect(answers).toEqual(Array(5).fill({ status: 'accepted' }));
    expect(await links(a, email)).toHaveLength(1);
    const events = await sql<{ id: string; props: unknown; actor: unknown }>`
      select id, props, actor from outbox
      where tenant_id = ${a} and type = 'reader.signin.requested'`.execute(operatorDb);
    const [link] = await links(a, email);
    // The event carries the link's id and nothing of the person or the client.
    expect(events.rows).toEqual([
      { id: link!.id, props: { linkId: link!.id }, actor: { kind: 'anonymous', channel: 'web' } },
    ]);
    expect(link!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The same address on another site is another reader: its own mail, its own limit.
    await request(b, email);
    expect(await links(b, email)).toHaveLength(1);
  });

  it('gives a link used twice at once exactly one winner', async () => {
    const email = `race-${run}@example.org`;
    await request(a, email, invoker, 'ip-race');
    const token = await tokenFor(a, email);
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map((i) => complete(a, token, invokers[i % 2]).then((r) => r.status))
    );
    expect(outcomes.sort()).toEqual(['invalid', 'invalid', 'invalid', 'signed_in']);
    expect(await complete(a, token)).toEqual({ status: 'invalid' });
    const supporter = await invoker.run(useCases.getSupporter, admin(a), { email });
    const log = await uow.run(admin(a), (ctx) => ctx.supporters.eventsFor(supporter.id));
    expect(log.map((e) => e.type)).toEqual(['reader.signed_in']);
    const sessions = await withTenant(operatorDb, admin(a), (trx) =>
      trx
        .selectFrom('reader_sessions')
        .select('id')
        .where('supporter_id', '=', supporter.id)
        .execute()
    );
    expect(sessions).toHaveLength(1);
  });

  it('keeps links and sessions per tenant and shows none without a tenant', async () => {
    const email = `ab-${run}@example.org`;
    await request(a, email, invoker, 'ip-ab');
    const token = await tokenFor(a, email);
    // The link of A is no row on B: not by its own token, not by one signed for B.
    expect(await complete(b, token)).toEqual({ status: 'invalid' });
    const [row] = await links(a, email);
    const forB = await signinToken(signer, b, {
      id: row!.id,
      expiresAt: new Date(row!.expires_at),
    });
    expect(await complete(b, forB)).toEqual({ status: 'invalid' });
    expect(await links(b, email)).toHaveLength(0);

    const done = await complete(a, token);
    if (done.status !== 'signed_in') throw new Error(done.status);
    const session = (await sessionOf(a, done.sessionToken))!;
    expect(await sessionOf(b, done.sessionToken)).toBeNull();
    // A reader of A who signs out on B ends nothing.
    await invoker.run(useCases.signoutReader, readerPrincipal(b, session.sessionId), {});
    expect(await sessionOf(a, done.sessionToken)).not.toBeNull();

    // Forced RLS: the app login without a tenant context sees no row of either table.
    for (const table of ['reader_signin_links', 'reader_sessions'] as const) {
      const seen = await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(
        pools[0]!
      );
      expect(Number(seen.rows[0]!.n)).toBe(0);
    }
  });

  it('lets the app end a link or a session and change nothing else', async () => {
    const email = `grants-${run}@example.org`;
    const done = await signedIn(a, email);
    const session = (await sessionOf(a, done.sessionToken))!;
    const asApp = (statement: ReturnType<typeof sql>) =>
      withTenant(pools[0]!, admin(a), (trx) => statement.execute(trx));
    for (const statement of [
      sql`update reader_signin_links set email = 'x@example.org'`,
      sql`update reader_signin_links set expires_at = now() + interval '1 year'`,
      sql`update reader_signin_links set token_hash = repeat('0', 64)`,
      sql`delete from reader_signin_links`,
      sql`update reader_sessions set expires_at = now() + interval '1 year'`,
      sql`update reader_sessions set supporter_id = id`,
      sql`delete from reader_sessions`,
    ])
      await expect(asApp(statement)).rejects.toThrow(/permission denied/);

    await invoker.run(useCases.signoutReader, readerPrincipal(a, session.sessionId), {});
    expect(await sessionOf(a, done.sessionToken)).toBeNull();
  });

  it('erases the pending link with its mail intent, and the session, for good', async () => {
    const email = `gone-${run}@example.org`;
    const done = await signedIn(a, email);
    const supporter = await invoker.run(useCases.getSupporter, admin(a), { email });
    // A second, pending link a day later, with a mail attempt whose outcome is unknown.
    ahead += 25 * 60 * 60 * 1000;
    await request(a, email, invoker, 'ip-gone-2');
    const pending = (await links(a, email)).at(-1)!;
    const message: MailMessage = {
      from: { email: 'noreply@example.org' },
      to: { email },
      subject: 's',
      text: 't',
      html: 'h',
      stream: 'transactional',
    };
    const failing = {
      send: async () => {
        throw new Error('timeout');
      },
      lookup: async () => null,
    };
    expect(
      await sendOnce(
        { mailer: failing, clock, uow },
        { id: pending.id, tenantId: a },
        SIGNIN_MAIL_SUBSCRIBER,
        message
      )
    ).toBe('unknown');
    const intents = () =>
      sql<{ n: string }>`
        select count(*) as n from mail_sends where tenant_id = ${a} and event_id = ${pending.id}`
        .execute(operatorDb)
        .then((r) => Number(r.rows[0]!.n));
    const jobs = () =>
      sql<{ n: string }>`
        select count(*) as n from jobs
        where tenant_id = ${a} and type = 'mail.reconcile'
          and payload->>'eventId' = ${pending.id}`
        .execute(operatorDb)
        .then((r) => Number(r.rows[0]!.n));
    expect(await intents()).toBe(1);
    expect(await jobs()).toBe(1);

    await uow.run(admin(a), (ctx) => ctx.erasures.register(supporter.id, email));
    // Registered, not yet applied: the session is already over.
    expect(await sessionOf(a, done.sessionToken)).toBeNull();
    expect(await applyErasures(operatorDb, a)).toBeGreaterThan(0);
    expect(await links(a, email)).toHaveLength(0);
    expect(await intents()).toBe(0);
    expect(await jobs()).toBe(0);
    const sessions = await withTenant(operatorDb, admin(a), (trx) =>
      trx
        .selectFrom('reader_sessions')
        .select('id')
        .where('supporter_id', '=', supporter.id)
        .execute()
    );
    expect(sessions).toHaveLength(0);
    expect(await applyErasures(operatorDb, a)).toBe(0);

    // The erased address gets the same answer, no link and no session.
    ahead += 25 * 60 * 60 * 1000;
    expect(await request(a, email, invoker, 'ip-gone-3')).toEqual({ status: 'accepted' });
    expect(await links(a, email)).toHaveLength(0);
    expect(
      await complete(
        a,
        await signinToken(signer, a, { id: pending.id, expiresAt: new Date(pending.expires_at) })
      )
    ).toEqual({ status: 'invalid' });
  });

  it('sweeps only what expired more than an hour ago, whatever the sweep asks', async () => {
    const email = `sweep-${run}@example.org`;
    await signedIn(b, email);
    const supporter = await invoker.run(useCases.getSupporter, admin(b), { email });
    const live = {
      links: await count('reader_signin_links', b),
      sessions: await count('reader_sessions', b),
    };
    expect(live.links).toBeGreaterThan(0);
    expect(live.sessions).toBeGreaterThan(0);
    const DAY = 24 * 60 * 60 * 1000;
    const old = () =>
      uow.run(admin(b), async (ctx) => {
        const createdAt = new Date(Date.now() - 3 * DAY);
        const expiresAt = new Date(Date.now() - 2 * DAY);
        await ctx.signinLinks.insert({
          id: uuidv7Ids.next(),
          email,
          tokenHash: '0'.repeat(64),
          locale: 'nl',
          returnPath: null,
          createdAt,
          expiresAt,
          consumedAt: null,
        });
        await ctx.readerSessions.insert({
          id: uuidv7Ids.next(),
          supporterId: supporter.id,
          createdAt,
          expiresAt,
          revokedAt: null,
        });
      });
    await old();
    // The janitor's own policies: a delete of everything reaches no live row.
    await asRole(operatorDb, 'mycel_janitor', async (trx) => {
      await sql`delete from reader_signin_links`.execute(trx);
      await sql`delete from reader_sessions`.execute(trx);
    });
    expect(await count('reader_signin_links', b)).toBe(live.links);
    expect(await count('reader_sessions', b)).toBe(live.sessions);

    await old();
    expect(await sweepRateLimits(operatorDb)).toBeGreaterThanOrEqual(2);
    expect(await count('reader_signin_links', b)).toBe(live.links);
    expect(await count('reader_sessions', b)).toBe(live.sessions);
  });

  it('refuses a link past its time on the database clock of the use case', async () => {
    const email = `late-${run}@example.org`;
    await request(a, email, invoker, 'ip-late');
    const token = await tokenFor(a, email);
    ahead += SIGNIN_LINK_TTL_MS;
    expect(await complete(a, token)).toEqual({ status: 'invalid' });
    expect(await invoker.run(useCases.getSupporter, admin(a), { email }).catch((e) => e.code)).toBe(
      'not_found'
    );
  });
});
