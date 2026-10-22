// `mailing.confirm` (ADR 010 rule 5) and the send-once contract (ADR 019 rule 6) in memory. The
// mailer stub below is the outside world (testing.md rule 4): it can lose the response after the
// provider accepted the message, which is the case an intent row exists for.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import {
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  probeForm,
  probeTenant,
} from '../testing/index.js';
import { supporterIngestSubscriber } from '../supporters/service.js';
import {
  CONFIRMATION_SUBSCRIBER,
  confirmationMailSubscriber,
  renderConfirmationMail,
  sendOnce,
  signConfirmToken,
} from './confirmation.js';
import type { MailMessage, Mailer, SendVerdict } from './ports.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const FORM = '01900000-0000-7000-8000-00000000f000';
const DAY = 24 * 60 * 60 * 1000;

describe('mailing.confirm', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let submissionId: string;

  const visitor = (tenant = TENANT) => anonymousPrincipal(tenant, ['forms:write'], 'ip');
  const token = (fields: Partial<{ tenantId: string; submissionId: string; list: string }> = {}) =>
    signConfirmToken(
      uow.signer,
      { tenantId: TENANT, submissionId, list: 'newsletter', ...fields },
      clock.now()
    );
  const confirm = async (t: string, principal = visitor()) =>
    invoker.run(useCases.confirmSubscription, principal, { token: t });

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(TENANT, 'test');
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
    const result = await invoker.run(useCases.submitForm, admin, {
      formId: FORM,
      values: { email: 'ada@example.org', consent: true },
      locale: 'nl',
    });
    if (result.status !== 'accepted') throw new Error(result.status);
    submissionId = result.submissionId;
    uow.store.outbox.length = 0;
  });

  it('confirms once and publishes consent.given with the submission as evidence', async () => {
    const t = await token();
    expect(await confirm(t)).toEqual({ status: 'confirmed' });
    expect(uow.store.outbox).toHaveLength(1);
    expect(uow.store.outbox[0]).toMatchObject({
      type: 'consent.given',
      tenantId: TENANT,
      occurredAt: clock.now(),
      actor: { kind: 'anonymous' },
      props: {
        email: 'ada@example.org',
        list: 'newsletter',
        formId: FORM,
        submissionId,
        locale: 'nl',
        consentTextVersion: 'newsletter-2026-10',
        confirmedAt: clock.now().toISOString(),
      },
    });
    const stored = await uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.submissions.findById(submissionId)
    );
    expect(stored?.confirmedAt).toEqual(clock.now());

    // The second click, even with a freshly signed token, is an outcome without an event.
    clock.advance(1000);
    expect(await confirm(await token())).toEqual({ status: 'already_confirmed' });
    expect(uow.store.outbox).toHaveLength(1);
  });

  it('treats a forged, expired or foreign token as invalid, without an event', async () => {
    expect(await confirm('forged')).toEqual({ status: 'invalid' });
    const t = await token();
    clock.advance(15 * DAY);
    expect(await confirm(t)).toEqual({ status: 'invalid' });
    clock.current = new FakeClock().now();
    // A link for this tenant followed on another tenant's site, and vice versa.
    expect(await confirm(await token(), visitor(OTHER))).toEqual({ status: 'invalid' });
    expect(await confirm(await token({ tenantId: OTHER }))).toEqual({ status: 'invalid' });
    // A token for a list the form does not add to, or a submission that is gone.
    expect(await confirm(await token({ list: 'other' }))).toEqual({ status: 'invalid' });
    expect(
      await confirm(await token({ submissionId: '01900000-0000-7000-8000-0000000000ff' }))
    ).toEqual({ status: 'invalid' });
    expect(uow.store.outbox).toHaveLength(0);
    const stored = await uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.submissions.findById(submissionId)
    );
    expect(stored?.confirmedAt).toBeNull();
  });

  it('is the second step of the public flow: forms:write suffices, nothing less does', async () => {
    await expect(
      confirm(await token(), anonymousPrincipal(TENANT, ['forms:read']))
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

/**
 * A provider that can accept a message and then lose the response (`timeout`), or refuse it
 * (`error`). `verdict` is what its records say when asked about an earlier attempt.
 */
class FlakyMailer implements Mailer {
  readonly delivered: string[] = [];
  readonly asked: { key: string; since: Date }[] = [];
  mode: 'ok' | 'timeout' | 'error' = 'ok';
  verdict: SendVerdict = 'not_sent';

  async send(_message: MailMessage, key: string): Promise<{ providerId: string }> {
    if (this.mode === 'error') throw new Error('TEM API 429: quota exceeded');
    this.delivered.push(key);
    if (this.mode === 'timeout') throw new Error('fetch failed: timeout');
    return { providerId: `p-${this.delivered.length}` };
  }
  async wasSent(key: string, _message: MailMessage, since: Date): Promise<SendVerdict> {
    this.asked.push({ key, since });
    return this.verdict;
  }
}

describe('sendOnce (ADR 019 rule 6)', () => {
  const event = { id: '01900000-0000-7000-8000-00000000e001', tenantId: TENANT };
  const message = renderConfirmationMail({
    locale: 'en',
    tenantName: 'Probe',
    confirmUrl: 'https://example.org/probe/confirm?token=x',
    from: { email: 'noreply@example.org' },
    to: 'ada@example.org',
  });
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let mailer: FlakyMailer;
  const key = `test:${event.id}`;
  const intent = () => uow.store.for(TENANT).mailSends.get(key);
  const attempt = () => sendOnce({ mailer, clock, uow }, event, 'test', message);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    mailer = new FlakyMailer();
  });

  it('writes the intent before the provider call and completes it after', async () => {
    expect(await attempt()).toBe('sent');
    expect(mailer.delivered).toEqual([key]);
    expect(intent()).toMatchObject({
      key,
      subscriber: 'test',
      eventId: event.id,
      attemptedAt: clock.now(),
      sentAt: clock.now(),
      providerId: 'p-1',
      lastError: null,
    });
    // Redelivery of the same event: nothing is asked, nothing is sent.
    expect(await attempt()).toBe('skipped');
    expect(mailer.delivered).toHaveLength(1);
    expect(mailer.asked).toHaveLength(0);
  });

  it('after a lost response it reconciles and never sends blind', async () => {
    mailer.mode = 'timeout';
    const started = clock.now();
    await expect(attempt()).rejects.toThrow('timeout');
    expect(mailer.delivered).toEqual([key]);
    expect(intent()).toMatchObject({
      attemptedAt: started,
      sentAt: null,
      lastError: 'fetch failed: timeout',
    });

    // The provider cannot answer yet: no retry, the outbox backs off.
    mailer.mode = 'ok';
    mailer.verdict = 'unknown';
    clock.advance(60_000);
    await expect(attempt()).rejects.toThrow(/unknown; not resending/);
    expect(mailer.asked).toEqual([{ key, since: started }]);
    expect(mailer.delivered).toHaveLength(1);
    expect(intent()?.sentAt).toBeNull();

    // The provider has it: the intent completes without a second message.
    mailer.verdict = 'sent';
    expect(await attempt()).toBe('reconciled');
    expect(mailer.delivered).toHaveLength(1);
    expect(intent()).toMatchObject({ sentAt: clock.now(), providerId: null });
    expect(await attempt()).toBe('skipped');
  });

  it('resends only when the provider says the attempt never arrived', async () => {
    mailer.mode = 'error';
    await expect(attempt()).rejects.toThrow('429');
    expect(mailer.delivered).toHaveLength(0);
    expect(intent()).toMatchObject({ sentAt: null, lastError: 'TEM API 429: quota exceeded' });

    mailer.mode = 'ok';
    mailer.verdict = 'not_sent';
    clock.advance(60_000);
    expect(await attempt()).toBe('sent');
    expect(mailer.delivered).toEqual([key]);
    expect(intent()).toMatchObject({
      attemptedAt: clock.now(),
      sentAt: clock.now(),
      providerId: 'p-1',
    });
  });
});

describe('confirmationMailSubscriber', () => {
  it('sends one confirmation per signup event under its own intent key', async () => {
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock });
    const mailer = new MemoryMailer();
    const subscriber = confirmationMailSubscriber({
      mailer,
      signer: uow.signer,
      clock,
      tenants: new MemoryTenants([probeTenant(TENANT)]),
      uow,
      from: { email: 'noreply@example.org' },
      platform: { platformOrigin: 'https://example.org', siteUrlMode: 'path' },
    });
    const event = {
      id: '01900000-0000-7000-8000-00000000e002',
      type: 'newsletter.subscribed',
      tenantId: TENANT,
      occurredAt: clock.now(),
      actor: { kind: 'system' as const, job: 'test' },
      props: {
        email: 'ada@example.org',
        list: 'newsletter',
        formId: FORM,
        submissionId: '01900000-0000-7000-8000-00000000s001',
        locale: 'nl',
        pageUrl: null,
        consentTextVersion: 'v1',
        confirmed: false,
      },
    };
    await subscriber.handle(event);
    await subscriber.handle(event);
    expect(mailer.sent).toHaveLength(1);
    expect([...mailer.keys]).toEqual([`${CONFIRMATION_SUBSCRIBER}:${event.id}`]);
    expect(mailer.sent[0]?.text).toContain('https://example.org/probe/confirm?token=');

    // An already confirmed signup (trusted integration) gets no mail and no intent.
    await subscriber.handle({ ...event, id: 'e3', props: { ...event.props, confirmed: true } });
    expect(mailer.sent).toHaveLength(1);
    expect(uow.store.for(TENANT).mailSends.size).toBe(1);

    // The ingest subscriber reads the same event types the confirm flow produces.
    expect(supporterIngestSubscriber(uow).types).toEqual([
      'newsletter.subscribed',
      'consent.given',
    ]);
  });
});
