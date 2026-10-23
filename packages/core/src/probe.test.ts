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
} from './testing/index.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
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

  async function submit(
    values: Record<string, string | boolean>,
    opts: { wait?: number; ip?: string; honeypot?: string | null; form?: string } = {}
  ) {
    const token = await startedToken(opts.form);
    clock.advance(opts.wait ?? 4000);
    return invoker.run(useCases.submitForm, visitor(opts.ip), {
      formId: opts.form ?? FORM,
      values,
      locale: 'en',
      pageUrl: 'https://example.org/probe/signup',
      spam: {
        startedToken: token,
        ...(opts.honeypot !== null && { honeypot: opts.honeypot ?? '' }),
      },
    });
  }

  /** The reasons of the `forms.submit.rejected` lines so far, and that no line names more. */
  const rejections = () =>
    log.lines
      .filter((l) => l.message === 'forms.submit.rejected')
      .map((l) => {
        expect(Object.keys(l.fields).sort()).toEqual(['formId', 'reason']);
        return l.fields['reason'];
      });

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

  it('publishes a locale only when every visible field has a value in it', async () => {
    const page = probePage(FORM);
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      ...page,
      slug: 'x',
      document: { ...page.document, title: { en: 'Only English' } },
    });
    await expect(
      invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('isolates tenants', async () => {
    await expect(
      invoker.run(useCases.getPublished, anonymousPrincipal(OTHER, ['content:read']), {
        type: 'page',
        slug: 'signup',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
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

  it('returns field errors as i18n keys', async () => {
    const result = await submit({ email: 'not-an-address' });
    expect(result).toEqual({
      status: 'invalid',
      errors: [
        { field: 'email', message: 'forms.error.email.invalid' },
        { field: 'consent', message: 'forms.error.consent.required' },
      ],
    });
    expect(uow.store.outbox).toHaveLength(0);
  });

  it('rejects the honeypot, a missing or forged timing token, and fast submissions', async () => {
    expect(
      await submit({ email: 'a@example.org', consent: 'on' }, { honeypot: 'http://spam' })
    ).toMatchObject({ status: 'rejected', reason: 'spam' });
    expect(await submit({ email: 'a@example.org', consent: 'on' }, { wait: 1000 })).toMatchObject({
      status: 'rejected',
      reason: 'too-fast',
    });
    const forged = await invoker.run(useCases.submitForm, visitor(), {
      formId: FORM,
      values: { email: 'a@example.org', consent: 'on' },
      locale: 'en',
      spam: { startedToken: '{"f":"x","t":0}~forged', honeypot: '' },
    });
    expect(forged).toMatchObject({ status: 'rejected', reason: 'spam' });
    expect(uow.store.outbox).toHaveLength(0);
    expect(rejections()).toEqual(['honeypot', 'too-fast', 'token-invalid']);
  });

  it('rate-limits per IP, visibly', async () => {
    for (let i = 0; i < 10; i++)
      await submit({ email: `p${i}@example.org`, consent: 'on' }, { ip: 'busy' });
    expect(
      await submit({ email: 'fresh@example.org', consent: 'on' }, { ip: 'busy' })
    ).toMatchObject({ reason: 'rate-limited', message: 'forms.rejected.rate-limited' });
    expect(rejections()).toEqual(['ip-limited']);
  });

  // Brief form-intake § 1 and § 6 (a): one confirmation per address per form per 24 hours.
  it('sends one confirmation per address per form a day, silently, on a sliding window', async () => {
    const OTHER_FORM = '01900000-0000-7000-8000-00000000f001';
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(OTHER_FORM)));
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(await submit({ email: 'same@example.org', consent: 'on' }, { ip: `ip-${i}` }));
    expect(results.map((r) => r.status)).toEqual([
      'accepted',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(results[1]).toEqual({ status: 'rejected', reason: 'recipient-limited', message: '' });
    expect(uow.store.for(TENANT).submissions.size).toBe(1);
    expect(uow.store.outbox.filter((e) => e.type === 'newsletter.subscribed')).toHaveLength(1);
    expect(rejections()).toEqual(Array(4).fill('recipient-limited'));

    // Another form of the same tenant is its own consent scope.
    expect(
      (await submit({ email: 'same@example.org', consent: 'on' }, { form: OTHER_FORM })).status
    ).toBe('accepted');
    // Sliding from the one that went through, not on a day boundary: a second short of a day
    // after it still refused, a second past it one more confirmation. Each `submit` waits 4 s;
    // the first went through 20 s ago.
    const day = 24 * 60 * 60 * 1000;
    clock.advance(day - 20_000 - 4000 - 1000);
    expect((await submit({ email: 'same@example.org', consent: 'on' })).status).toBe('rejected');
    clock.advance(2000 - 4000);
    expect((await submit({ email: 'same@example.org', consent: 'on' })).status).toBe('accepted');
    expect((await submit({ email: 'same@example.org', consent: 'on' })).status).toBe('rejected');
  });

  // § 6 (b): checklist rule 8, a post without the honeypot field is not from our form.
  it('refuses an anonymous post without the honeypot field as spam', async () => {
    expect(await submit({ email: 'a@example.org', consent: 'on' }, { honeypot: null })).toEqual({
      status: 'rejected',
      reason: 'spam',
      message: '',
    });
    expect(uow.store.for(TENANT).submissions.size).toBe(0);
    expect(rejections()).toEqual(['honeypot']);
  });

  // § 6 (c): a failing port is a failure, never an accepted signup or a rejection.
  it('throws when storing the submission fails, and publishes nothing', async () => {
    uow.store.for(TENANT).submissions.set = () => {
      throw new Error('connection terminated');
    };
    await expect(submit({ email: 'a@example.org', consent: 'on' })).rejects.toThrow(
      'connection terminated'
    );
    expect(uow.store.outbox).toHaveLength(0);
  });

  // § 6 (d): the token lives 24 hours; a page rendered afresh gives a fresh one (#30A).
  it('refuses a timing token older than a day and accepts a fresh one', async () => {
    const old = await startedToken();
    clock.advance(24 * 60 * 60 * 1000 + 1000);
    const post = (token: string) =>
      invoker.run(useCases.submitForm, visitor(), {
        formId: FORM,
        values: { email: 'late@example.org', consent: 'on' },
        locale: 'en',
        spam: { startedToken: token, honeypot: '' },
      });
    expect(await post(old)).toMatchObject({ status: 'rejected', reason: 'spam' });
    const fresh = await startedToken();
    clock.advance(4000);
    expect((await post(fresh)).status).toBe('accepted');
    expect(rejections()).toEqual(['token-invalid']);
  });

  it('lets trusted integrations submit without timing token but not past the rate limit', async () => {
    const result = await invoker.run(useCases.submitForm, admin, {
      formId: FORM,
      values: { email: 'api@example.org', consent: true },
      locale: 'nl',
    });
    expect(result.status).toBe('accepted');
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
