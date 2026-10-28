// The vertical probe in memory: a page published and read, capability checks, and one signup
// all the way through outbox, supporter projection, confirmation mail and the confirm click.
// Each module's own rules live in its own tests (`content/`, `forms/`, `supporters/`); this file
// only proves the pieces meet.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  Invoker,
  UseCaseError,
  buildRegistry,
  confirmationMailSubscriber,
  negotiateLocale,
  rebuildProjection,
  supporterIngestSubscriber,
  systemPrincipal,
  anonymousPrincipal,
  t,
  useCases,
  en,
  nl,
  toSupporterEvent,
  renderConfirmationMail,
  verifyConfirmToken,
  type Principal,
} from './index.js';
import {
  FakeClock,
  MemoryLogger,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  probeForm,
  probePage,
  probeTenant,
  publishProbePage,
  solveProof,
} from './testing/index.js';
import { issueProofChallenge } from './forms/proof.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const FORM = '01900000-0000-7000-8000-00000000f000';

describe('vertical probe in memory', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;
  let mailer: MemoryMailer;
  let log: MemoryLogger;

  beforeEach(async () => {
    clock = new FakeClock();
    log = new MemoryLogger();
    uow = new MemoryUnitOfWork({ clock, log });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
    mailer = new MemoryMailer();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
    await publishProbePage(invoker, admin, FORM);
  });

  const reader = () => anonymousPrincipal(TENANT, ['content:read', 'forms:read']);
  const visitor = (ip = 'ip-1') => anonymousPrincipal(TENANT, ['forms:write'], ip);

  async function startedToken(form = FORM): Promise<string> {
    const { startedToken } = await invoker.run(useCases.getForm, reader(), { id: form });
    return startedToken;
  }

  /**
   * A valid proof without the real search: a challenge signed by the same signer over a tiny
   * space. The handler trusts its own signature, not `maxNumber`, so this is what a browser
   * would post; the real search space is covered in `forms/service.test.ts`.
   */
  async function cheapProof(form = FORM): Promise<string> {
    const challenge = await uow.run(admin, (ctx) =>
      issueProofChallenge(ctx.signer, form, clock.now(), 20)
    );
    return solveProof(challenge);
  }

  async function submit(
    values: Record<string, string | boolean>,
    opts: {
      wait?: number;
      ip?: string;
      honeypot?: string | null;
      form?: string;
      /** `null` posts no proof (a browser without JavaScript). */
      proof?: string | null;
    } = {}
  ) {
    const token = await startedToken(opts.form);
    const proof = opts.proof === undefined ? await cheapProof(opts.form) : opts.proof;
    clock.advance(opts.wait ?? 4000);
    return invoker.run(useCases.submitForm, visitor(opts.ip), {
      formId: opts.form ?? FORM,
      values,
      locale: 'en',
      pageUrl: 'https://example.org/probe/signup',
      spam: {
        startedToken: token,
        ...(opts.honeypot !== null && { honeypot: opts.honeypot ?? '' }),
        ...(proof !== null && { proof }),
      },
    });
  }

  it('creates, publishes and reads a page; unknown block types and missing forms are rejected', async () => {
    const page = await invoker.run(useCases.getPublished, reader(), {
      type: 'page',
      slug: 'signup',
    });
    expect(page.blocks.map((b) => b.type)).toEqual(['heading', 'signup-form']);

    const other = (blocks: unknown[]) => ({
      ...probePage(FORM),
      slug: 'other',
      document: { ...probePage(FORM).document, blocks },
    });
    await expect(
      invoker.call(
        admin,
        'content.item.create',
        other([{ type: 'carousel', version: 1, props: {} }])
      )
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      invoker.run(useCases.createItem, admin, {
        ...probePage('01900000-0000-7000-8000-00000000dead'),
        slug: 'other',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(invoker.run(useCases.createItem, admin, probePage(FORM))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('authorizes by capability: a visitor can submit but cannot read supporters', async () => {
    await expect(
      invoker.run(useCases.getSupporter, visitor(), { email: 'a@example.org' })
    ).rejects.toBeInstanceOf(UseCaseError);
    await expect(
      invoker.call(visitor(), 'content.item.create', probePage(FORM))
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('accepts a signup, publishes the event, projects the supporter and sends a confirmation', async () => {
    const result = await submit({ email: ' Ada@Example.org ', consent: 'on' });
    expect(result.status).toBe('accepted');
    expect(uow.store.outbox).toHaveLength(1);
    expect(uow.store.outbox[0]?.type).toBe('newsletter.subscribed');

    const tenants = new MemoryTenants([probeTenant(TENANT)]);
    const subscribers = [
      supporterIngestSubscriber(uow),
      confirmationMailSubscriber({
        mailer,
        signer: uow.signer,
        clock,
        tenants,
        uow,
        from: { email: 'noreply@example.org', name: 'Probe' },
        platform: { platformOrigin: 'https://example.org/', siteUrlMode: 'path' },
      }),
    ];
    const event = uow.store.outbox[0]!;
    await uow.drain(subscribers);

    // Before the link is followed the list is pending, not a membership (ADR 010 rule 5).
    const supporter = await invoker.run(useCases.getSupporter, admin, { email: 'ada@example.org' });
    expect(supporter).toMatchObject({ lists: [], pendingLists: ['newsletter'] });
    expect(supporter.firstSeen).toBe(clock.now().toISOString());

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to.email).toBe('ada@example.org');
    expect(mail.subject).toBe('Confirm your subscription to Probe');
    const url = new URL(/https:\/\/example\.org\/probe\/confirm\?token=\S+/.exec(mail.text)![0]);
    const payload = await verifyConfirmToken(
      uow.signer,
      url.searchParams.get('token')!,
      clock.now()
    );
    expect(payload).toMatchObject({ tenantId: TENANT, list: 'newsletter' });

    // Redelivery (at-least-once) does not duplicate the log, nor the mail (intent row).
    await subscribers[0]!.handle(event);
    await subscribers[1]!.handle(event);
    expect(uow.store.for(TENANT).events.size).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    // Opening the link reads; the button's post records consent once (TODO #22B), and the list
    // moves from pending to confirmed.
    clock.advance(60_000);
    expect(
      await invoker.run(useCases.previewConfirmation, visitor('ip-2'), {
        token: url.searchParams.get('token')!,
      })
    ).toEqual({ status: 'pending', locale: 'en' });
    expect(uow.store.outbox).toEqual([]);
    const click = () =>
      invoker.run(useCases.confirmSubscription, visitor('ip-2'), {
        token: url.searchParams.get('token')!,
      });
    expect(await click()).toEqual({ status: 'confirmed', locale: 'en' });
    expect(uow.store.outbox.map((e) => e.type)).toEqual(['consent.given']);
    await uow.drain(subscribers);
    expect(
      await invoker.run(useCases.getSupporter, admin, { email: 'ada@example.org' })
    ).toMatchObject({ lists: ['newsletter'], pendingLists: [] });
    expect(uow.store.for(TENANT).events.size).toBe(2);

    expect(await click()).toEqual({ status: 'already_confirmed', locale: 'en' });
    expect(uow.store.outbox).toHaveLength(0);
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('supporter projection', () => {
  it('is deterministic: applying events equals a rebuild in any input order', async () => {
    const mk = (min: number, list: string) =>
      toSupporterEvent({
        id: `e${min}`,
        type: 'newsletter.subscribed',
        tenantId: TENANT,
        occurredAt: new Date(Date.UTC(2026, 9, 21, 12, min)),
        actor: { kind: 'system', job: 'test' },
        props: {
          email: 'x@example.org',
          list,
          formId: FORM,
          submissionId: `s${min}`,
          locale: 'nl',
          pageUrl: null,
          consentTextVersion: 'v1',
          confirmed: false,
        },
      });
    const supporter_id = '01900000-0000-7000-8000-0000000000aa';
    const events = (await Promise.all([mk(5, 'b'), mk(1, 'a'), mk(3, 'a')])).map((e) => ({
      ...e,
      supporter_id,
    }));
    const forward = rebuildProjection(events);
    const backward = rebuildProjection([...events].reverse());
    expect(forward).toEqual(backward);
    expect(forward).toMatchObject({
      lists: [],
      pendingLists: ['a', 'b'],
      firstSeen: '2026-10-21T12:01:00.000Z',
      lastActivity: '2026-10-21T12:05:00.000Z',
    });
    expect(events[0]?.id).toMatch(/^[0-9a-f]{40}$/);
    expect(events[0]?.source_site).toBe(`urn:mycel:form:${FORM}`);
  });
});

describe('i18n', () => {
  it('renders the confirmation mail in nl and en from the catalogs', () => {
    const base = {
      tenantName: 'Probe',
      confirmUrl: 'https://x.test/c?t=1',
      from: { email: 'a@x.test' },
      to: 'b@x.test',
    };
    const nlMail = renderConfirmationMail({ ...base, locale: 'nl' });
    const enMail = renderConfirmationMail({ ...base, locale: 'en' });
    expect(nlMail.subject).toBe('Bevestig je inschrijving bij Probe');
    expect(enMail.subject).toBe('Confirm your subscription to Probe');
    expect(nlMail.html).toContain('lang="nl"');
    expect(nlMail.text).toContain('https://x.test/c?t=1');
  });

  it('falls back to English per key and negotiates locales', () => {
    expect(t('de', 'forms.error.required')).toBe(en['forms.error.required']);
    expect(Object.keys(en).filter((k) => !(k in nl))).toEqual([]);
    expect(negotiateLocale('en-GB,en;q=0.9,nl;q=0.8', ['nl', 'en'], 'nl')).toBe('en');
    expect(negotiateLocale('fr', ['nl', 'en'], 'nl')).toBe('nl');
    expect(negotiateLocale(null, ['nl', 'en'], 'nl')).toBe('nl');
  });
});
