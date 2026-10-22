// `mailing.confirm` (ADR 010 rule 5) and the confirmation subscriber in memory. The send-once
// contract (ADR 019 rule 6) has its own suite, delivery.test.ts.

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
  signConfirmToken,
} from './confirmation.js';

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
