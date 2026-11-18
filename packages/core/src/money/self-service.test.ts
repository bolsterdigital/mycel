// Donor self-service over the memory adapter (ADR 005 rule 6, brief MY-254 PR 3): the mails the
// charge run sends, the signed link in them, what the link reaches and what it does not, the
// request form's one answer, and the reader who sees their gifts without a link.

import { beforeEach, describe, expect, it } from 'vitest';
import { issueStartedToken } from '../forms/spam.js';
import { Invoker } from '../invoke.js';
import type { MailMessage } from '../mailing/ports.js';
import {
  anonymousPrincipal,
  readerPrincipal,
  systemPrincipal,
  type Principal,
} from '../principal.js';
import { SupporterEvent } from '../supporters/events.js';
import { ingest } from '../supporters/service.js';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
  probeTenant,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { givingMailSubscriber } from './giving-mail.js';
import {
  GIVING_NOTICE,
  SELF_FORM_SCOPE,
  SELF_LINK_REQUESTED,
  SELF_LINK_TTL_MS,
  selfToken,
} from './self-service-model.js';
import { chargeSubscription, startSubscription } from './subscriptions.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const DAY = 24 * 60 * 60 * 1000;

describe('donor self-service (ADR 005 rule 6)', () => {
  let clock: FakeClock;
  let provider: FakePaymentProvider;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let mailer: MemoryMailer;

  const admin = principal({
    capabilities: ['donations:read', 'donations:write', 'supporters:read'],
  });
  const visitor = (tenant = TENANT, ip = 'ip'): Principal =>
    anonymousPrincipal(tenant, ['content:read'], ip);
  const run = systemPrincipal(TENANT, 'subscriptions.charge');

  async function supporter(email: string) {
    await uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `self-test:${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: `test:${email}`,
          props: { list: 'news' },
        })
      )
    );
    return invoker.run(useCases.getSupporter, admin, { email });
  }

  /** A monthly gift of € 10 whose first payment is paid. */
  async function gift(email = 'noor@example.org', amount = 1000) {
    const giver = await supporter(email);
    const started = await uow.run(admin, (ctx) =>
      startSubscription(ctx, {
        amount,
        currency: 'EUR',
        description: 'Maandelijkse donatie',
        locale: 'nl',
        returnUrl: 'http://localhost:5173/probe/donation/{token}',
        interval: 'month',
        supporterId: giver.id,
      })
    );
    provider.settle(`fake_${started.paymentId}`, 'paid');
    await invoker.run(useCases.checkDonation, admin, {
      paymentId: started.paymentId,
      cause: 'webhook',
    });
    return { giver, subscriptionId: started.subscriptionId };
  }

  const deps = () => ({
    mailer,
    signer: uow.signer,
    clock,
    tenants: new MemoryTenants([
      probeTenant(TENANT),
      { ...probeTenant(OTHER), slug: 'other', name: 'Other' },
    ]),
    uow,
    from: { email: 'noreply@example.org' },
    platform: uow.platform,
  });
  /** Every notice the outbox held so far, in order; `drain` empties it, so read it first. */
  const seen = new Map<string, unknown>();
  const notices = () => {
    for (const e of uow.store.outbox)
      if (e.type === GIVING_NOTICE) seen.set(e.id, e.props['notice']);
    return [...seen.values()];
  };
  const deliver = () => {
    notices();
    return uow.drain([givingMailSubscriber(deps())]);
  };
  const linkOf = (message: MailMessage | undefined) =>
    message?.text.split('\n').find((line) => line.startsWith('http')) ?? '';
  const tokenOf = (message: MailMessage | undefined) =>
    decodeURIComponent(linkOf(message).split('/my-giving/')[1]?.split('?')[0] ?? '');

  const get = (token: string | undefined, p: Principal = visitor()) =>
    invoker.run(useCases.getOwnGifts, p, token ? { token } : {});
  const change = (
    token: string | undefined,
    subscriptionId: string,
    action: 'amount' | 'pause' | 'resume' | 'cancel',
    amount?: number,
    p: Principal = visitor()
  ) =>
    invoker.run(useCases.updateOwnGift, p, {
      ...(token ? { token } : {}),
      subscriptionId,
      action,
      ...(amount === undefined ? {} : { amount }),
    });
  const read = (subscriptionId: string) =>
    invoker.run(useCases.getSubscription, admin, { subscriptionId });

  async function spam() {
    const startedToken = await issueStartedToken(uow.signer, SELF_FORM_SCOPE, clock.now());
    clock.advance(5000);
    return { honeypot: '', startedToken };
  }
  const request = async (email: string, p: Principal = visitor()) =>
    invoker.run(useCases.requestOwnGiftsLink, p, { email, locale: 'nl', spam: await spam() });

  beforeEach(() => {
    clock = new FakeClock();
    provider = new FakePaymentProvider();
    uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
    invoker = new Invoker(buildRegistry(), uow);
    mailer = new MemoryMailer();
    seen.clear();
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
  });

  it('mails the giver when the gift starts, with a link to their own page', async () => {
    const { subscriptionId } = await gift();
    expect(notices()).toEqual(['started']);
    const event = uow.store.outbox.find((e) => e.type === GIVING_NOTICE)!;
    // The outbox names the gift and the facts the mail states, never an address or a token.
    expect(JSON.stringify(event.props)).not.toMatch(/@|token/);
    await deliver();
    const mail = mailer.sent.at(-1)!;
    expect(mail.to.email).toBe('noor@example.org');
    expect(mail.subject).toBe('Bedankt voor je gift aan Probe');
    expect(mail.text).toMatch(/€\s10 per maand/);
    expect(linkOf(mail)).toMatch(/\/probe\/my-giving\/.+\?lang=nl$/);
    const { gifts } = await get(tokenOf(mail));
    expect(gifts).toEqual([
      expect.objectContaining({ id: subscriptionId, status: 'active', amount: 1000 }),
    ]);
  });

  it('changes the amount from the next charge, and pauses and resumes it', async () => {
    const { subscriptionId } = await gift();
    await deliver();
    const token = tokenOf(mailer.sent.at(-1));
    expect((await change(token, subscriptionId, 'amount', 2500)).gift.amount).toBe(2500);
    const paused = (await change(token, subscriptionId, 'pause')).gift;
    expect(paused).toMatchObject({ status: 'paused', nextChargeAt: null });
    const paidThrough = paused.paidThrough!;

    // Within the paid period: the next charge stays at its end.
    expect((await change(token, subscriptionId, 'resume')).gift).toMatchObject({
      status: 'active',
      nextChargeAt: paidThrough,
    });
    clock.current = new Date(paidThrough);
    expect(await chargeSubscription(uow, run, subscriptionId)).toBe('charged');
    expect(provider.charges.at(-1)?.amount).toBe(2500);

    const { ledger } = await read(subscriptionId);
    expect(ledger.map((e) => `${e.step}:${e.cause}`)).toEqual([
      'started:checkout',
      'activated:webhook',
      'amount-changed:donor',
      'paused:donor',
      'resumed:donor',
      'renewed:charge',
    ]);
  });

  it('starts a new run of periods when resumed after the paid period, without charging the gap', async () => {
    const { subscriptionId } = await gift();
    await deliver();
    const token = tokenOf(mailer.sent.at(-1));
    await change(token, subscriptionId, 'pause');
    clock.advance(3 * DAY); // still within the link's week
    const before = (await read(subscriptionId)).subscription.paidThrough!;
    clock.current = new Date(new Date(before).getTime() + DAY);
    // The link from the start mail is older than a week by now: ask for a new one.
    await request('noor@example.org');
    await deliver();
    const fresh = tokenOf(mailer.sent.at(-1));
    const now = clock.now().toISOString();
    expect((await change(fresh, subscriptionId, 'resume')).gift).toMatchObject({
      status: 'active',
      startedAt: now,
      paidThrough: now,
      nextChargeAt: now,
    });
    expect(await chargeSubscription(uow, run, subscriptionId)).toBe('charged');
    expect(provider.charges).toHaveLength(1);
    expect((await read(subscriptionId)).subscription.paidThrough).not.toBe(now);
  });

  it('stops the gift and mails that it stopped', async () => {
    const { subscriptionId } = await gift();
    await deliver();
    const token = tokenOf(mailer.sent.at(-1));
    expect((await change(token, subscriptionId, 'cancel')).gift.status).toBe('cancelled');
    // A second stop changes nothing; a pause of a stopped gift is a conflict.
    expect((await change(token, subscriptionId, 'cancel')).gift.status).toBe('cancelled');
    await expectCode(change(token, subscriptionId, 'pause'), 'conflict');
    expect(notices()).toEqual(['started', 'cancelled']);
    await deliver();
    expect(mailer.sent.at(-1)!.subject).toBe('Je gift aan Probe is gestopt');
    expect(linkOf(mailer.sent.at(-1))).toBe('');
  });

  it('mails a failed charge with the next attempt, and the end after dunning', async () => {
    const { subscriptionId } = await gift();
    provider.chargesAs = 'failed';
    clock.current = new Date((await read(subscriptionId)).subscription.paidThrough!);
    await chargeSubscription(uow, run, subscriptionId);
    await deliver();
    const failed = mailer.sent.at(-1)!;
    expect(failed.subject).toBe('Je gift aan Probe kon niet worden afgeschreven');
    expect(failed.text).toMatch(/We proberen het opnieuw op \d+ \w+ 20\d\d/);
    expect(linkOf(failed)).toMatch(/\/my-giving\//);
    for (const days of [3, 4]) {
      clock.advance(days * DAY);
      await chargeSubscription(uow, run, subscriptionId);
    }
    expect(notices()).toEqual(['started', 'charge-failed', 'charge-failed', 'ended']);
    await deliver();
    expect(mailer.sent.at(-1)!.subject).toBe('Je gift aan Probe is beëindigd');
  });

  it('gives one not_found for a forged, expired, other site’s or someone else’s link', async () => {
    const { subscriptionId } = await gift();
    const other = await gift('ada@example.org');
    const adaToken = await selfToken(
      uow.signer,
      TENANT,
      other.giver.id,
      new Date(clock.now().getTime() + DAY)
    );
    await expectCode(get('forged'), 'not_found');
    // Ada's link reaches Ada's gift and not Noor's.
    expect((await get(adaToken)).gifts.map((g) => g.id)).toEqual([other.subscriptionId]);
    await expectCode(change(adaToken, subscriptionId, 'cancel'), 'not_found');
    // A token of this supporter for another site.
    const elsewhere = await selfToken(
      uow.signer,
      OTHER,
      other.giver.id,
      new Date(clock.now().getTime() + DAY)
    );
    await expectCode(get(elsewhere), 'not_found');
    // Past its week.
    clock.advance(SELF_LINK_TTL_MS + 1);
    await expectCode(get(adaToken), 'not_found');
    // No token and nobody signed in.
    await expectCode(get(undefined), 'not_found');
    expect((await read(subscriptionId)).subscription.status).toBe('active');
  });

  it('ends the link of an erased giver at once', async () => {
    const { giver } = await gift();
    await deliver();
    const token = tokenOf(mailer.sent.at(-1));
    await uow.run(admin, (ctx) => ctx.erasures.register(giver.id, 'noor@example.org'));
    await expectCode(get(token), 'not_found');
  });

  it('mails a link only to an address that gives here, once a day, with one answer for all', async () => {
    await gift();
    await supporter('reader@example.org');
    for (const email of ['noor@example.org', 'reader@example.org', 'nobody@example.org'])
      expect(await request(email)).toEqual({ status: 'accepted' });
    expect(uow.store.outbox.filter((e) => e.type === SELF_LINK_REQUESTED)).toHaveLength(1);
    expect(await request('noor@example.org')).toEqual({ status: 'accepted' });
    expect(uow.store.outbox.filter((e) => e.type === SELF_LINK_REQUESTED)).toHaveLength(1);
    // Without the form's honeypot and timing token: a bot, the same answer, nothing sent.
    clock.advance(DAY + 1000);
    await invoker.run(useCases.requestOwnGiftsLink, visitor(), {
      email: 'noor@example.org',
      locale: 'nl',
    });
    expect(uow.store.outbox.filter((e) => e.type === SELF_LINK_REQUESTED)).toHaveLength(1);
    await deliver();
    const mail = mailer.sent.find((m) => m.subject === 'Beheer je gift aan Probe')!;
    expect(mail.to.email).toBe('noor@example.org');
    expect((await get(tokenOf(mail))).gifts).toHaveLength(1);
  });

  it('shows a signed-in reader their gifts without a link, and only theirs', async () => {
    const { giver, subscriptionId } = await gift();
    const other = await gift('ada@example.org');
    const session = {
      id: '01900000-0000-7000-8000-00000000cccc',
      supporterId: giver.id,
      createdAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + DAY),
      revokedAt: null,
    };
    await uow.run(admin, (ctx) => ctx.readerSessions.insert(session));
    const reader = readerPrincipal(TENANT, session.id);
    expect((await get(undefined, reader)).gifts.map((g) => g.id)).toEqual([subscriptionId]);
    await expectCode(
      change(undefined, other.subscriptionId, 'pause', undefined, reader),
      'not_found'
    );
    expect((await change(undefined, subscriptionId, 'pause', undefined, reader)).gift.status).toBe(
      'paused'
    );
  });

  it('refuses an amount without the amount action, and the reverse', async () => {
    const { subscriptionId } = await gift();
    await deliver();
    const token = tokenOf(mailer.sent.at(-1));
    await expectCode(change(token, subscriptionId, 'amount'), 'invalid_input');
    await expectCode(change(token, subscriptionId, 'pause', 500), 'invalid_input');
  });
});
