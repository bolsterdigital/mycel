// Mail intent rows and the janitor against Postgres (ADR 019 rule 6, ADR 011 rule 2). The memory
// adapter proves the send-once protocol; this suite proves what only the database can: the intent
// commits before the provider call and survives a lost response, two simultaneous clicks on one
// link confirm once, the janitor deletes across tenants and the application role cannot.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  anonymousPrincipal,
  buildRegistry,
  renderConfirmationMail,
  sendOnce,
  signConfirmToken,
  systemPrincipal,
  useCases,
  type MailMessage,
  type Mailer,
  type SendVerdict,
} from '@mycel/core';
import { FakeSigner, probeForm } from '@mycel/core/testing';
import {
  createDb,
  createUnitOfWork,
  migrate,
  sweepRateLimits,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

/** The provider: accepts and loses the response (`timeout`), or answers about an earlier attempt. */
class FlakyMailer implements Mailer {
  readonly delivered: string[] = [];
  mode: 'ok' | 'timeout' = 'ok';
  verdict: SendVerdict = 'unknown';
  async send(_m: MailMessage, key: string) {
    this.delivered.push(key);
    if (this.mode === 'timeout') throw new Error('fetch failed: timeout');
    return { providerId: `p-${this.delivered.length}` };
  }
  async wasSent() {
    return this.verdict;
  }
}

describe.skipIf(!operatorUrl || !appUrl)('mailing conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const signer = new FakeSigner();
  const clock = { now: () => new Date() };
  const uow = createUnitOfWork(appDb, { clock, ids: uuidv7Ids, signer });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = Math.random().toString(36).slice(2, 8);
  let tenantId = '';
  let formId = '';
  const admin = () => systemPrincipal(tenantId, 'test');
  const message = renderConfirmationMail({
    locale: 'en',
    tenantName: 'M',
    confirmUrl: 'http://localhost/m/confirm?token=x',
    from: { email: 'noreply@example.org' },
    to: 'ada@example.org',
  });

  beforeAll(async () => {
    await migrate(operatorUrl!, { appPassword: process.env['MYCEL_APP_PASSWORD'], log: () => {} });
    tenantId = (
      await upsertTenant(operatorDb, {
        id: uuidv7(),
        slug: `mail-${run}`,
        name: 'M',
        defaultLocale: 'nl',
        locales: ['nl'],
      })
    ).id;
    formId = uuidv7();
    await uow.run(admin(), (ctx) => ctx.forms.insert(probeForm(formId)));
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('commits the intent before the provider call and reconciles a lost response', async () => {
    const mailer = new FlakyMailer();
    const event = { id: uuidv7(), tenantId };
    const key = `test:${event.id}`;
    const intent = () => uow.run(admin(), (ctx) => ctx.mailSends.get(key));

    mailer.mode = 'timeout';
    await expect(sendOnce({ mailer, clock, uow }, event, 'test', message)).rejects.toThrow(
      'timeout'
    );
    // The row is there, committed, attempted and not sent: the state a crash would leave.
    expect(await intent()).toMatchObject({
      subscriber: 'test',
      eventId: event.id,
      sentAt: null,
      lastError: 'fetch failed: timeout',
    });
    expect((await intent())?.attemptedAt).toBeInstanceOf(Date);

    mailer.mode = 'ok';
    await expect(sendOnce({ mailer, clock, uow }, event, 'test', message)).rejects.toThrow(
      /unknown; not resending/
    );
    mailer.verdict = 'sent';
    expect(await sendOnce({ mailer, clock, uow }, event, 'test', message)).toBe('reconciled');
    expect(mailer.delivered).toEqual([key]);
    expect((await intent())?.sentAt).toBeInstanceOf(Date);
    expect(await sendOnce({ mailer, clock, uow }, event, 'test', message)).toBe('skipped');
  });

  it('confirms once when two clicks on one link race', async () => {
    const submitted = await invoker.run(useCases.submitForm, admin(), {
      formId,
      values: { email: `race-${run}@example.org`, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(submitted.status);
    const token = await signConfirmToken(
      signer,
      { tenantId, submissionId: submitted.submissionId, list: 'newsletter' },
      clock.now()
    );
    const click = () =>
      invoker.run(useCases.confirmSubscription, anonymousPrincipal(tenantId, ['forms:write']), {
        token,
      });
    const results = await Promise.all([click(), click(), click()]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'already_confirmed',
      'already_confirmed',
      'confirmed',
    ]);
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from outbox where tenant_id = ${tenantId} and type = 'consent.given'
    `.execute(operatorDb);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('keeps no address in mail_sends', async () => {
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'mail_sends'`.execute(operatorDb);
    expect(rows.map((r) => r.column_name)).not.toContain('email');
    expect(rows.map((r) => r.column_name)).not.toContain('recipient');
  });

  it('lets only the janitor delete expired rate-limit windows', async () => {
    // Windows from two days ago, written through the real limiter with a clock in the past.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const old = createUnitOfWork(appDb, {
      clock: { now: () => twoDaysAgo },
      ids: uuidv7Ids,
      signer,
    });
    await old.run(admin(), (ctx) =>
      ctx.rateLimits.hit(`janitor-${run}`, { max: 5, windowSeconds: 60 })
    );
    await uow.run(admin(), (ctx) =>
      ctx.rateLimits.hit(`janitor-${run}`, { max: 5, windowSeconds: 60 })
    );
    const count = async () =>
      Number(
        (
          await sql<{ n: string }>`select count(*) as n from rate_limits
            where tenant_id = ${tenantId} and key = ${`janitor-${run}`}`.execute(operatorDb)
        ).rows[0]?.n
      );
    expect(await count()).toBe(2);

    await expect(
      uow.run(admin(), () => sql`delete from rate_limits`.execute(appDb))
    ).rejects.toThrow(/permission denied/);

    expect(await sweepRateLimits(operatorDb)).toBeGreaterThanOrEqual(1);
    expect(await count()).toBe(1);
  });
});
