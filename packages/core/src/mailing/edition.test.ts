// An article as a newsletter (ADR 010 rules 8 and 9, ADR 018 rule 4, ADR 019 rules 5 and 6), in
// memory: what `mailing.edition.send` stores and refuses, and what the delivery job hands to the
// provider, to whom, how often and how fast. The provider is the outside world: `MemoryMailer`
// records what it accepted. The edition's immutability under the database grant and the member
// query are in packages/db/src/mailing.test.ts.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS, type TenantAccess } from '../entitlements/model.js';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import { ingest } from '../supporters/service.js';
import { SupporterEvent } from '../supporters/events.js';
import {
  expectCode,
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  pageDocument,
  principal,
  probeTenant,
  TENANT,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { exampleId } from '../util/ids.js';
import {
  deliverEdition,
  EDITION_SUBSCRIBER,
  editionMailSource,
  editionTestMailSubscriber,
  type EditionMailDeps,
} from './edition-delivery.js';
import { EDITION_SENT, EDITION_TEST_REQUESTED } from './edition.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './email.js';
import { recipientIntentKey } from './send-attempts.js';
import { ONE_CLICK_VALUE } from './unsubscribe.js';

const SITE = { name: 'Probe', url: 'http://localhost:5173/probe', defaultLocale: 'nl' };
const MINUTE = 60 * 1000;
const LIST = 'newsletter';

describe('mailing.edition', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let mailer: MemoryMailer;
  let access: TenantAccess;
  let deps: EditionMailDeps;
  let itemId: string;
  let n = 0;

  const admin = systemPrincipal(TENANT, 'test');
  const article = (over: Record<string, unknown> = {}) => ({
    ...pageDocument({ title: { nl: 'Nieuws van november', en: 'News of November' } }),
    type: 'article' as const,
    delivery: { email: { listId: LIST, subject: { nl: 'Het nieuws', en: 'The news' } } },
    ...over,
  });
  const publish = async (id: string, revisionId: string, locales = ['nl', 'en']) => {
    for (const locale of locales)
      await invoker.run(useCases.publishItem, admin, { itemId: id, revisionId, locale });
  };
  const signup = (
    email: string,
    props: Record<string, unknown> = {},
    type = 'newsletter.subscribed'
  ) =>
    uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `signup-${++n}`,
          type,
          email,
          occurred_at: new Date(clock.now().getTime() - 60_000 + n).toISOString(),
          source: 'test',
          source_site: 'urn:test',
          source_ref: `test:${n}`,
          props: { list: LIST, confirmed: true, locale: 'nl', ...props },
        })
      )
    );
  const idOf = async (email: string) =>
    (await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.id;
  const send = (locales = ['nl', 'en'], as = admin) =>
    invoker.run(useCases.sendEdition, as, { itemId, locales, site: SITE });
  const edition = (id: string) => uow.run(admin, (ctx) => ctx.mailEditions.get(id));
  const deliver = (id: string) => deliverEdition(deps, TENANT, id);
  const to = () => mailer.sent.map((m) => m.to.email).sort();

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    mailer = new MemoryMailer();
    access = DEFAULT_ACCESS;
    deps = {
      mailer,
      signer: uow.signer,
      clock,
      tenants: new MemoryTenants([probeTenant(TENANT)]),
      uow,
      from: { email: 'noreply@example.org' },
      platform: uow.platform,
      access: async () => access,
    };
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'november',
      document: article(),
    });
    itemId = item.id;
    await publish(item.id, revision.id);
  });

  it('stores one edition with a row per locale, publishes its event and plans the delivery', async () => {
    await signup('ada@example.org');
    await signup('bob@example.org');
    await signup('pending@example.org', { confirmed: false });
    const out = await send();
    expect(out).toMatchObject({ list: LIST, recipients: 2, locales: ['nl', 'en'] });

    const stored = (await edition(out.editionId))!;
    expect(stored).toMatchObject({ itemId, list: LIST, recipients: 2, completedAt: null });
    expect(stored.locales.map((l) => [l.locale, l.subject])).toEqual([
      ['nl', 'Het nieuws'],
      ['en', 'The news'],
    ]);
    // One mail for everyone: the recipient's own link is not in what is stored.
    expect(stored.locales[0]!.html).toContain(UNSUBSCRIBE_PLACEHOLDER);

    const event = uow.store.outbox.find((e) => e.type === EDITION_SENT)!;
    expect(event.id).toBe(out.editionId);
    expect(JSON.stringify(event.props)).not.toContain('@');
    expect(uow.store.jobs.filter((j) => j.type === 'mailing.edition.deliver')).toMatchObject([
      { key: `mailing.edition.deliver:${out.editionId}`, payload: { editionId: out.editionId } },
    ]);
    expect(mailer.sent).toEqual([]);
  });

  it('delivers to confirmed members only, each with their own unsubscribe link and headers', async () => {
    await signup('ada@example.org');
    await signup('bob@example.org', { locale: 'en' });
    await signup('pending@example.org', { confirmed: false });
    await signup('other@example.org', { list: 'events' });
    await signup('gone@example.org');
    await signup('gone@example.org', {}, 'newsletter.unsubscribed');
    const { editionId } = await send();

    expect(await deliver(editionId)).toEqual({});
    expect(to()).toEqual(['ada@example.org', 'bob@example.org']);
    expect((await edition(editionId))!.completedAt).toEqual(clock.now());

    const ada = mailer.sent.find((m) => m.to.email === 'ada@example.org')!;
    expect(ada).toMatchObject({
      stream: 'bulk',
      subject: 'Het nieuws',
      from: { email: 'noreply@example.org', name: 'Probe' },
      headers: { 'List-Unsubscribe-Post': ONE_CLICK_VALUE },
    });
    const oneClick = ada.headers!['List-Unsubscribe']!.slice(1, -1);
    expect(oneClick).toMatch(/^http:\/\/localhost:5173\/probe\/unsubscribe\/one-click\?token=/);
    const link = oneClick.replace('/one-click', '');
    expect(ada.text).toContain(link);
    expect(ada.html).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    expect(ada.text).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    // The link is this recipient's: it unsubscribes Ada and nobody else.
    const token = decodeURIComponent(new URL(link).searchParams.get('token')!);
    await invoker.run(useCases.confirmOptOut, admin, { token });
    expect(await uow.run(admin, (ctx) => ctx.supporters.countMembers(LIST))).toBe(1);

    // The locale of the signup when the edition has it.
    expect(mailer.sent.find((m) => m.to.email === 'bob@example.org')!.subject).toBe('The news');
    expect([...mailer.keys].sort()).toEqual(
      [await idOf('ada@example.org'), await idOf('bob@example.org')]
        .map((id) => recipientIntentKey(EDITION_SUBSCRIBER, id, editionId))
        .sort()
    );
  });

  it("falls back to the site's default locale for a signup in a locale the edition lacks", async () => {
    await signup('claire@example.org', { locale: 'fr' });
    await signup('dan@example.org', { locale: 'en' });
    const { editionId } = await send(['nl']);
    await deliver(editionId);
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Het nieuws', 'Het nieuws']);
  });

  it('sends nothing to a supporter whose erasure is registered but not applied yet', async () => {
    await signup('ada@example.org');
    await signup('erased@example.org');
    const erased = await idOf('erased@example.org');
    const { editionId } = await send();
    await uow.run(admin, (ctx) => ctx.erasures.register(erased, 'erased@example.org'));
    await deliver(editionId);
    expect(to()).toEqual(['ada@example.org']);
  });

  it('does not send twice when the job runs again, from the start or in parallel', async () => {
    await signup('ada@example.org');
    await signup('bob@example.org');
    const { editionId } = await send();
    await Promise.all([deliver(editionId), deliver(editionId)]);
    expect(to()).toEqual(['ada@example.org', 'bob@example.org']);

    // A worker that died before it recorded its place starts over: the intents hold.
    const row = uow.store.for(TENANT).mailEditions.get(editionId)!;
    row.deliveredThrough = null;
    row.completedAt = null;
    await deliver(editionId);
    expect(mailer.sent).toHaveLength(2);
  });

  it('keeps the edition as sent when the article is corrected afterwards', async () => {
    await signup('ada@example.org');
    const first = await send();
    const before = await edition(first.editionId);

    const item = (await uow.run(admin, (ctx) => ctx.content.get(itemId)))!;
    const { revision } = await invoker.run(useCases.updateItem, admin, {
      itemId,
      baseRevisionId: item.latestRevisionId,
      document: article({
        title: { nl: 'Nieuws van november (gecorrigeerd)', en: 'News of November (corrected)' },
        delivery: { email: { listId: LIST, subject: { nl: 'Correctie', en: 'Correction' } } },
      }),
    });
    await publish(itemId, revision.id);

    expect(await edition(first.editionId)).toEqual(before);
    await deliver(first.editionId);
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Het nieuws']);

    // Sending again is a new edition, of what is published now.
    const second = await send();
    expect(second.editionId).not.toBe(first.editionId);
    expect((await edition(second.editionId))!.locales[0]!.subject).toBe('Correctie');
    await deliver(second.editionId);
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Het nieuws', 'Correctie']);

    // The list names both, newest first; reading the first shows it as it went out.
    const { editions } = await invoker.run(useCases.listEditions, admin, { itemId });
    expect(editions.map((e) => e.id)).toEqual([second.editionId, first.editionId]);
    expect(editions[1]).toEqual({
      id: first.editionId,
      list: LIST,
      recipients: 1,
      sentAt: first.sentAt,
      completedAt: expect.any(String),
      locales: [
        { locale: 'en', subject: 'The news' },
        { locale: 'nl', subject: 'Het nieuws' },
      ],
    });
    const sent = await invoker.run(useCases.getEdition, admin, {
      itemId,
      locale: 'nl',
      site: SITE,
      editionId: first.editionId,
    });
    expect(sent).toMatchObject({
      subject: 'Het nieuws',
      recipients: 1,
      revisionId: before!.locales.find((l) => l.locale === 'nl')!.revisionId,
    });
    expect(sent.html).toContain('Nieuws van november');
    expect(sent.html).not.toContain('gecorrigeerd');
    expect(sent.text).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    // Only an edition of this item, in a locale it went out in.
    for (const wrong of [
      { itemId, locale: 'de', editionId: first.editionId },
      { itemId: exampleId(0x9), locale: 'nl', editionId: first.editionId },
    ])
      await expectCode(
        invoker.run(useCases.getEdition, admin, { ...wrong, site: SITE }),
        'not_found'
      );
  });

  it('refuses a locale that is not published, restricted content and an article without a list', async () => {
    const make = async (slug: string, over: Record<string, unknown>, locales: string[]) => {
      const { item, revision } = await invoker.run(useCases.createItem, admin, {
        slug,
        document: article(over),
      });
      await publish(item.id, revision.id, locales);
      return item.id;
    };
    const issue = async (id: string, locales: string[]) => {
      const e = await expectCode(
        invoker.run(useCases.sendEdition, admin, { itemId: id, locales, site: SITE }),
        'conflict'
      );
      return e.issues[0]!.message;
    };
    expect(await issue(await make('half', {}, ['nl']), ['nl', 'en'])).toBe(
      'mailing.edition.not-published'
    );
    const restricted = await make(
      'leden',
      { access: { level: 'members', teaser: 'lead' }, lead: { nl: 'Alleen voor leden.' } },
      ['nl']
    );
    expect(await issue(restricted, ['nl'])).toBe('mailing.edition.restricted');
    expect(await issue(await make('web', { delivery: {} }, ['nl']), ['nl'])).toBe(
      'mailing.edition.no-delivery'
    );
    expect(uow.store.for(TENANT).mailEditions.size).toBe(0);
    // The same answer before anything is sent.
    await expectCode(
      invoker.run(useCases.getEdition, admin, { itemId: restricted, locale: 'nl', site: SITE }),
      'conflict'
    );
  });

  it('needs mailing:send: writing and publishing content sends nothing', async () => {
    const editor = principal({
      actor: { kind: 'operator', operatorId: '01900000-0000-7000-8000-00000000a001' },
      capabilities: ['content:read', 'content:write', 'content:publish'],
    });
    await expectCode(send(['nl'], editor), 'forbidden');
    await expectCode(
      invoker.run(useCases.testEdition, editor, { itemId, locale: 'nl', site: SITE }),
      'forbidden'
    );
    // Reading what would be sent is content:read.
    const preview = await invoker.run(useCases.getEdition, editor, {
      itemId,
      locale: 'nl',
      site: SITE,
    });
    expect(preview).toMatchObject({ subject: 'Het nieuws', list: LIST, recipients: 0 });
    expect(preview.text).toContain(`${SITE.url}/unsubscribe`);
    expect(uow.store.for(TENANT).mailEditions.size).toBe(0);
  });

  it('refuses a send that would pass the monthly mail limit', async () => {
    await signup('ada@example.org');
    await signup('bob@example.org');
    const tight = principal({ entitlements: { 'mail.monthly_max': 1 } });
    await expectCode(send(['nl'], tight), 'limit_exceeded');
    expect(uow.store.for(TENANT).mailEditions.size).toBe(0);
  });

  it('starts at most the tenant throughput per minute, over all its editions', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await signup(`${name}@example.org`);
    access = {
      ...DEFAULT_ACCESS,
      entitlements: { ...DEFAULT_ACCESS.entitlements, 'mail.bulk_per_minute': 2 },
    };
    const first = await send(['nl']);
    const second = await send(['nl']);

    const next = await deliver(first.editionId);
    expect(mailer.sent).toHaveLength(2);
    expect(next).toEqual({ next: new Date(clock.now().getTime() + MINUTE) });
    // The minute is used: another edition of the same tenant waits for it.
    expect(await deliver(second.editionId)).toEqual({
      next: new Date(clock.now().getTime() + MINUTE),
    });
    expect(mailer.sent).toHaveLength(2);

    clock.advance(MINUTE + 1);
    await deliver(first.editionId);
    expect(mailer.sent).toHaveLength(4);
    clock.advance(MINUTE + 1);
    expect(await deliver(first.editionId)).toEqual({});
    expect(mailer.sent).toHaveLength(5);
    expect(new Set(mailer.sent.map((m) => m.to.email)).size).toBe(5);
  });

  it('waits a day for a suspended tenant and for one without mailing', async () => {
    await signup('ada@example.org');
    const { editionId } = await send(['nl']);
    const day = { next: new Date(clock.now().getTime() + 24 * 60 * MINUTE) };
    access = { ...DEFAULT_ACCESS, status: 'suspended' };
    expect(await deliver(editionId)).toEqual(day);
    access = {
      ...DEFAULT_ACCESS,
      entitlements: { ...DEFAULT_ACCESS.entitlements, 'mailing.enabled': false },
    };
    expect(await deliver(editionId)).toEqual(day);
    expect(mailer.sent).toEqual([]);
  });

  it('rebuilds one recipient for a reconcile, and nothing once they unsubscribed', async () => {
    await signup('ada@example.org', { locale: 'en' });
    const ada = await idOf('ada@example.org');
    const { editionId } = await send();
    const event = uow.store.outbox.find((e) => e.id === editionId)!;
    const source = editionMailSource(deps);
    const key = recipientIntentKey(EDITION_SUBSCRIBER, ada, editionId);

    expect(await source(event, key)).toMatchObject({
      to: { email: 'ada@example.org' },
      subject: 'The news',
      stream: 'bulk',
    });
    expect(await source(event)).toBeNull();
    await signup('ada@example.org', {}, 'newsletter.unsubscribed');
    expect(await source(event, key)).toBeNull();
  });

  it('sends a test to the operator who asked, and to nobody on the list', async () => {
    await signup('ada@example.org');
    const member = await invoker.run(useCases.inviteMember, admin, {
      email: 'editor@example.org',
      capabilities: ['content:read', 'mailing:send'],
    });
    const editor = principal({
      actor: { kind: 'operator', operatorId: member.operatorId },
      capabilities: ['content:read', 'mailing:send'],
    });
    expect(
      await invoker.run(useCases.testEdition, editor, { itemId, locale: 'en', site: SITE })
    ).toEqual({ status: 'queued' });
    const event = uow.store.outbox.find((e) => e.type === EDITION_TEST_REQUESTED)!;
    expect(JSON.stringify(event.props)).not.toContain('@');

    await editionTestMailSubscriber(deps).handle(event);
    await editionTestMailSubscriber(deps).handle(event);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: { email: 'editor@example.org' },
      subject: '[Test] The news',
      stream: 'transactional',
    });
    expect(mailer.sent[0]!.headers).toBeUndefined();
    expect(uow.store.for(TENANT).mailEditions.size).toBe(0);

    // An API key has no address of its own.
    await expectCode(
      invoker.run(
        useCases.testEdition,
        principal({ actor: { kind: 'api-key', keyId: 'k' }, capabilities: ['mailing:send'] }),
        { itemId, locale: 'en', site: SITE }
      ),
      'forbidden'
    );
  });
});
